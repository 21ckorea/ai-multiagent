'use strict';

/**
 * @file playwright_naver_auth.js
 * @description 네이버 계정 인증 자동화 (Playwright)
 * @purpose  네이버 로그인 페이지에서 ID/PW 입력 및 2FA 처리를 자동화.
 *           프로필 디렉토리에 세션을 저장해 이후 재로그인 없이 재사용 가능.
 * @exports  loginWithNaver, isNaverLoggedIn
 * @seeAlso  playwright_naver_pipeline.js
 */


const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const {
  POST_SUCCESS_HOLD_MS,
  EXIT,
  RESULT,
  createLogger,
  sleep,
  CHROME_STEALTH_ARGS,
  PLAYWRIGHT_STEALTH_IGNORE_DEFAULT_ARGS,
  applyPlaywrightStealthInitScript,
} = require('./common');
const { extendBridgeProtocol } = require('./bridge_protocol');
const {
  harvestNaverCategories,
  logNaverCategoriesJsonLines,
  harvestNaverSubjects,
  logNaverSubjectsJsonLines,
} = require('./playwright_naver_category_harvest');

const ENGINE = 'Playwright';
const AUTH_TIMEOUT_MS = 120 * 1000;
const VERIFY_TIMEOUT_MS = 30 * 1000;
const URL_POLL_MS = 500;
const DEFAULT_NAVER_PROFILE_DIR = 'profiles/playwright-naver-profile';

function parseArgs() {
  const args = require('minimist')(process.argv.slice(2), {
    string: ['blog-id', 'blogId', 'profile-dir', 'profileDir', 'mode', 'naver-id', 'naverId', 'naver-password', 'naverPassword'],
    alias: { blogId: 'blog-id', profileDir: 'profile-dir', naverId: 'naver-id', naverPassword: 'naver-password' },
  });
  return {
    blogId: args['blog-id'] || args.blogId || '',
    profileDir: args['profile-dir'] || args.profileDir || '',
    mode: args.mode === 'verify' ? 'verify' : 'login',
    naverId: args['naver-id'] || args.naverId || '',
    naverPassword: args['naver-password'] || args.naverPassword || '',
  };
}

function normalizeNaverBlogId(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (/blog\.naver\.com/i.test(s)) {
    try {
      const u = new URL(s.includes('://') ? s : `https://${s}`);
      const seg = u.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)[0];
      return seg ? decodeURIComponent(seg) : '';
    } catch {
      return '';
    }
  }
  return s.replace(/^@/, '').trim();
}

function buildNaverBlogWriteUrl(naverBlogId) {
  const id = normalizeNaverBlogId(naverBlogId);
  if (!id) return '';
  return `https://blog.naver.com/${encodeURIComponent(id)}?Redirect=Write&`;
}

function computeNaverCredentialDigest(blogId) {
  const id = normalizeNaverBlogId(blogId);
  if (!id) return '';
  return crypto.createHash('sha256').update(`naver_blog_id_v1|${id}`, 'utf8').digest('hex');
}

function isNaverLoginFailureUrl(url) {
  try {
    const u = new URL(url);
    return (
      u.hostname.toLowerCase() === 'nid.naver.com' &&
      u.pathname.includes('nidlogin.login')
    );
  } catch {
    return false;
  }
}

function isNaverBlogWriteSuccessUrl(url, expectedBlogId) {
  if (!expectedBlogId) return false;
  try {
    const u = new URL(url);
    if (u.hostname.toLowerCase() !== 'blog.naver.com') return false;
    const seg =
      u.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)[0] || '';
    if (decodeURIComponent(seg) !== expectedBlogId) return false;
    return /Redirect=Write/i.test(u.search || '');
  } catch {
    return false;
  }
}

function logNaverAuth(logger, payload) {
  logger.info(`[NAVER] [AUTH] ${JSON.stringify(payload)}`);
}

async function tryDismissDraftPopup(page) {
  try {
    const clicked = await page.evaluate(() => {
      const popup =
        document.querySelector('.se-popup-container.__se-pop-layer') ||
        document.querySelector('.se-popup-container');
      if (!popup) return false;
      const titleEl = popup.querySelector('.se-popup-title');
      const titleText = (titleEl?.textContent || '').replace(/\s+/g, ' ').trim();
      if (!/작성\s*중인\s*글이\s*있습니다/.test(titleText)) return false;
      const btn =
        popup.querySelector('button.se-popup-button-cancel') ||
        popup.querySelector('.se-popup-button-cancel');
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (clicked) {
      await sleep(400);
    }
  } catch {
    /* ignore */
  }
}

async function run() {
  const logger = extendBridgeProtocol(createLogger(ENGINE));
  const args = parseArgs();
  const blogId = normalizeNaverBlogId(args.blogId);
  const writeUrl = buildNaverBlogWriteUrl(blogId);
  const digest = computeNaverCredentialDigest(blogId);
  const mode = args.mode;
  const naverId = args.naverId || '';
  const naverPassword = args.naverPassword || '';

  if (!blogId || !writeUrl) {
    logNaverAuth(logger, {
      ok: false,
      status: 'missing_blog_id',
      blogId: '',
      digest: '',
      message: 'Naver 아이디를 입력해 주세요.',
    });
    logger.result(RESULT.FAILED, 'missing_blog_id');
    return EXIT.FAILED;
  }

  logNaverAuth(logger, {
    ok: false,
    status: 'watch_started',
    blogId,
    digest,
    message: mode === 'verify'
        ? '저장된 세션으로 네이버 글쓰기 페이지 진입을 확인합니다.'
        : '네이버 글쓰기 URL을 열었습니다. 브라우저에서 로그인을 완료해 주세요.',
    url: writeUrl,
  });

  const userDataDir = path.resolve(
    process.cwd(),
    args.profileDir || (args.naverId ? 'profiles/playwright-naver-profile-' + args.naverId : DEFAULT_NAVER_PROFILE_DIR),
  );
  let context;
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    logger.info(`[NAVER] persistent profile: ${userDataDir}`);
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: args.headless === true,
      channel: 'chrome',
      args: CHROME_STEALTH_ARGS,
      ignoreDefaultArgs: PLAYWRIGHT_STEALTH_IGNORE_DEFAULT_ARGS,
    });
    await applyPlaywrightStealthInitScript(context);
    const page = context.pages()[0] ?? (await context.newPage());

    logger.info(`Navigating to ${writeUrl}`);
    await page.goto(writeUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await tryDismissDraftPopup(page);

    // Let any immediate (not-logged-in) redirect to the login page settle so the
    // initial write-URL flash isn't misread as success.
    await sleep(1200);

    const deadline = Date.now() + (mode === 'verify' ? VERIFY_TIMEOUT_MS : AUTH_TIMEOUT_MS);
    let loginWaitLogged = false;
    while (Date.now() < deadline) {
      const url = page.url();

      if (isNaverBlogWriteSuccessUrl(url, blogId)) {
        let hasPersistentAuth = false;
        try {
          const cookies = await context.cookies();
          hasPersistentAuth = cookies.some(
            (c) => c.name === 'NID_AUT' && typeof c.expires === 'number' && c.expires > 0,
          );
        } catch {
          /* ignore cookie read failure */
        }
        if (!hasPersistentAuth && mode === 'login') {
          logger.info(
            "[NAVER] [AUTH] WARNING: NID_AUT 영속 쿠키가 없습니다 — 브라우저를 닫으면 로그인이 풀립니다. 로그인 시 '로그인 상태 유지'를 체크해 주세요.",
          );
        }
        // Harvest the blog categories from the publish panel (best-effort).
        const harvest = await harvestNaverCategories(page, logger);
        logNaverCategoriesJsonLines(logger, harvest);
        // Also harvest the 블로그 주제 (subject/theme) list from the same panel.
        const subjectHarvest = await harvestNaverSubjects(page, logger);
        logNaverSubjectsJsonLines(logger, subjectHarvest);
        logNaverAuth(logger, {
          ok: true,
          status: 'success',
          blogId,
          digest,
          hasPersistentAuth,
          message: mode === 'verify'
            ? '저장된 세션으로 로그인 없이 글쓰기 페이지에 진입했습니다.'
            : hasPersistentAuth
              ? '네이버 인증이 완료되었습니다. 로그인 세션을 저장했습니다.'
              : "네이버 인증은 됐지만 '로그인 상태 유지' 미체크로 세션이 저장되지 않을 수 있습니다.",
          url,
        });
        logger.result(RESULT.SUCCESS, 'Naver auth verified');
        await sleep(POST_SUCCESS_HOLD_MS);
        return EXIT.SUCCESS;
      }

      if (isNaverLoginFailureUrl(url)) {
        if (mode === 'verify') {
          logNaverAuth(logger, {
            ok: false,
            status: 'login_required',
            blogId,
            digest,
            message:
              '저장된 세션이 없거나 만료되었습니다. 먼저 「연결하기」로 로그인해 주세요.',
            url,
          });
          logger.result(RESULT.FAILED, 'login_required');
          return EXIT.FAILED;
        }
        // login mode: try auto-fill if credentials were provided, then wait
        if (!loginWaitLogged) {
          loginWaitLogged = true;
          if (naverId && naverPassword) {
            logger.info('[NAVER] [AUTH] 자동 로그인을 시도합니다...');
            try {
              await page.waitForSelector('#id', { timeout: 5000 });
              await page.fill('#id', naverId);
              await sleep(300);
              await page.fill('#pw', naverPassword);
              await sleep(300);
              // Check '로그인 상태 유지' if unchecked
              try {
                const keepLogin = await page.$('#keep');
                if (keepLogin && !(await keepLogin.isChecked())) {
                  await keepLogin.click();
                  await sleep(200);
                }
              } catch { /* ignore */ }
              await page.click('.btn_login');
              logger.info('[NAVER] [AUTH] 자동 로그인 시도 완료. 인증 결과를 기다립니다...');
            } catch (autoFillErr) {
              logger.info(`[NAVER] [AUTH] 자동 로그인 시도 실패 (수동 로그인 필요): ${autoFillErr.message}`);
            }
          } else {
            logger.info(
              "[NAVER] [AUTH] 로그인 페이지가 열렸습니다. 브라우저에서 네이버 로그인을 완료해 주세요. ('로그인 상태 유지' 체크)",
            );
          }
        }
      }

      await sleep(URL_POLL_MS);
    }

    logNaverAuth(logger, {
      ok: false,
      status: 'timeout',
      blogId,
      digest,
      message: mode === 'verify'
          ? '세션 확인 시간이 초과되었습니다. 다시 시도해 주세요.'
          : '로그인 대기 시간이 초과되었습니다. 다시 시도해 주세요.',
    });
    logger.result(RESULT.FAILED, 'auth_timeout');
    return EXIT.FAILED;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logNaverAuth(logger, {
      ok: false,
      status: 'browser_error',
      blogId,
      digest,
      message: detail,
    });
    logger.error(detail);
    logger.result(RESULT.FAILED, 'browser_error');
    return EXIT.FAILED;
  } finally {
    if (context) {
      // Closing the persistent context flushes the profile (cookies/session) to userDataDir.
      await context.close().catch(() => {});
    }
  }
}

if (require.main === module) {
  run()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      const logger = createLogger(ENGINE);
      logger.error(error instanceof Error ? error.message : String(error));
      logger.result(RESULT.FAILED, 'Unhandled script error.');
      process.exitCode = EXIT.FAILED;
    });
}

module.exports = {
  normalizeNaverBlogId,
  buildNaverBlogWriteUrl,
  computeNaverCredentialDigest,
  isNaverLoginFailureUrl,
  isNaverBlogWriteSuccessUrl,
  logNaverAuth,
};
