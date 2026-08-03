'use strict';

/**
 * @file playwright_tistory_publish.js
 * @description 티스토리 블로그 글 발행 자동화 (Playwright)
 * @purpose  티스토리 에디터에 본문 HTML 주입 후 이미지 삽입, 공개 설정, 태그/카테고리 선택 후 최종 발행 자동화.
 * @exports  publishTistoryPost
 */

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
  buildNewPostUrl,
  isOnTistoryNewPost,
  isOnKakaoLogin,
  isSessionExpiredRedirect,
  normalizeFailureReason,
} = require('./tistory_common');
const {
  launchTistoryContext,
  runPublishLogin,
} = require('./playwright_tistory_login');
const {
  injectHtmlToNewPost,
  publishTistoryPostAfterGate,
  pasteImageAtPlaceholder,
} = require('./tistory_editor_inject');
const { DEFAULT_PUBLISH_TAB_POLICY } = require('./tistory_tab_policy');
const { extractImagePlaceholders } = require('./gemini_validate');
const { extractFirstH1PlainTextFromHtml } = require('./tistory_publish_harvest');
const { runGeminiSessionFromProfile, PROFILE_DIR: GEMINI_PROFILE_DIR } = require('./playwright_gemini_test');
const { DEFAULT_GEMINI_URL } = require('./gemini_common');
const { runGeminiImageGenerationWithRestarts } = require('./gemini_image');

const ENGINE = 'Playwright';
const PAGE_LOAD_TIMEOUT_MS = 60000;

function parseArgs(options = {}) {
  return {
    blogUrl: options.blogUrl || '',
    kakaoId: options.kakaoId || '',
    kakaoPassword: options.kakaoPassword || '',
    contentFile: options.contentFile || '',
    images: options.images || [],
    visibility: options.visibility || '2', // '0': 비공개, '2': 공개
    category: options.category || '',
    headless: options.headless !== false,
    withImages: options.withImages === true,
  };
}

function logTistoryPublishMarker(logger, payload) {
  logger.info(`[TISTORY] [PUBLISH] ${JSON.stringify(payload)}`);
}

async function run(options = {}) {
  const logger = options.logger || extendBridgeProtocol(createLogger(ENGINE));
  const args = parseArgs(options);

  if (!args.blogUrl) {
    logTistoryPublishMarker(logger, { ok: false, reason: 'missing_blog_url' });
    logger.result(RESULT.FAILED, 'missing_blog_url');
    return EXIT.FAILED;
  }

  const contentPath = args.contentFile ? path.resolve(args.contentFile) : '';
  if (!contentPath || !fs.existsSync(contentPath)) {
    logTistoryPublishMarker(logger, { ok: false, reason: 'missing_content_file', path: contentPath });
    logger.result(RESULT.FAILED, 'missing_content_file');
    return EXIT.FAILED;
  }

  let postData = {};
  try {
    postData = JSON.parse(fs.readFileSync(contentPath, 'utf8'));
  } catch (error) {
    logTistoryPublishMarker(logger, { ok: false, reason: 'invalid_json_content', error: error.message });
    logger.result(RESULT.FAILED, 'invalid_json_content');
    return EXIT.FAILED;
  }

  const title = postData.title || '새 블로그 포스트';
  let body = postData.body || '';

  // JSON에 blocks 형태로 글이 작성되어 있다면 HTML로 조립
  if (postData.blocks && Array.isArray(postData.blocks) && postData.blocks.length > 0) {
    let htmlContent = '';
    for (const block of postData.blocks) {
      if (block.type === 'heading') {
        htmlContent += `<h1>${block.text}</h1>`;
      } else if (block.type === 'summary') {
        htmlContent += `<p><strong>${block.text}</strong></p>`;
      } else if (block.type === 'paragraph') {
        htmlContent += `<p>${block.text}</p>`;
      } else if (block.type === 'imgplace') {
        htmlContent += `<!-- 이미지 삽입공간 : ${block.text} -->\n`;
      }
    }
    body = htmlContent;
  }

  // 티스토리 글쓰기 URL 빌드
  const newPostUrl = buildNewPostUrl(args.blogUrl);
  logger.info(`Tistory 자동 포스팅 진입 주소: ${newPostUrl}`);

  const profileSuffix = args.kakaoId ? '-' + args.kakaoId.replace(/[^a-zA-Z0-9]/g, '') : '';
  // WRITABLE_ROOT: 패키지 앱은 APP_DATA_DIR(userData), 개발 환경은 프로젝트 루트
  const _writableBase2 = process.env.APP_DATA_DIR
    ? path.resolve(process.env.APP_DATA_DIR)
    : path.resolve(__dirname, '../..');
  const profileDir = path.resolve(_writableBase2, 'profiles/playwright-tistory-profile' + profileSuffix);
  fs.mkdirSync(profileDir, { recursive: true });

  const publishArgs = [...CHROME_STEALTH_ARGS];
  if (args.headless) {
    const idx = publishArgs.indexOf('--start-maximized');
    if (idx > -1) publishArgs.splice(idx, 1);
    publishArgs.push('--window-position=-32000,-32000');
    publishArgs.push('--window-size=1,1');
    publishArgs.push('--noerrdialogs');
    publishArgs.push('--no-sandbox');
  }

  let context;
  try {
    const launched = await launchTistoryContext(profileDir, logger, args.headless);
    context = launched.context;
    let page = launched.page;

    const tistoryArgs = {
      blogUrl: args.blogUrl,
      kakaoId: args.kakaoId,
      kakaoPassword: args.kakaoPassword,
      profileDir,
      mode: 'publish',
    };

    logger.info('티스토리 로그인 검증 및 에디터 진입 중...');
    let loginOutcome = await runPublishLogin(
      page,
      tistoryArgs,
      newPostUrl,
      logger,
      context,
      launched.dialogSession ? [launched.dialogSession] : [],
      DEFAULT_PUBLISH_TAB_POLICY
    );

    let isHeadlessLoginNeeded = false;
    let startUrl = page.url();

    // 만약 헤드리스 모드인데 로그인이 실패했거나 카카오 로그인 화면에 남아있다면, 헤드풀 모드로 재시작
    if ((!loginOutcome.ok || isOnKakaoLogin(startUrl) || isSessionExpiredRedirect(startUrl)) && args.headless) {
      logger.info('[TISTORY] 헤드리스 모드에서 로그인이 필요합니다. 창 모드로 브라우저를 재시작합니다...');
      isHeadlessLoginNeeded = true;
      await context.close().catch(() => {});

      const launchedHeadful = await launchTistoryContext(profileDir, logger, false);
      context = launchedHeadful.context;
      page = launchedHeadful.page;

      loginOutcome = await runPublishLogin(
        page,
        tistoryArgs,
        newPostUrl,
        logger,
        context,
        launchedHeadful.dialogSession ? [launchedHeadful.dialogSession] : [],
        DEFAULT_PUBLISH_TAB_POLICY
      );
    }

    startUrl = page.url();
    if (!loginOutcome.ok || (!isOnTistoryNewPost(startUrl) && (isOnKakaoLogin(startUrl) || isSessionExpiredRedirect(startUrl)))) {
      logTistoryPublishMarker(logger, { ok: false, reason: 'login_required_waiting', url: startUrl });
      logger.info('티스토리 로그인이 필요합니다. 브라우저 창에서 60초 내에 직접 로그인해 주세요.');

      let ready = false;
      const editorWaitMs = 60000;
      const editorWaitStart = Date.now();

      while (Date.now() - editorWaitStart < editorWaitMs) {
        const currentUrl = page.url();
        if (isOnTistoryNewPost(currentUrl)) {
          ready = true;
          break;
        }
        await sleep(1000);
      }

      if (!ready) {
        logTistoryPublishMarker(logger, { ok: false, reason: 'login_timeout' });
        logger.result(RESULT.FAILED, 'login_timeout');
        return EXIT.FAILED;
      }
      logger.info('티스토리 로그인 감지 완료! 포스팅을 계속 진행합니다.');
    }

    await tryDismissDraftPopup(page, logger);

    // 에디터 HTML 주입
    const finalHtml = `<h1>${title}</h1>\n${body}`;
    logger.info('티스토리 에디터에 본문 주입 시작...');
    const injectResult = await injectHtmlToNewPost(
      page,
      finalHtml,
      {
        isPublic: args.visibility === '2',
        autoPublish: false,
        deferAutoPublish: true,
        blogUrl: args.blogUrl,
        categoryItemElementId: args.category || '',
      },
      logger
    );

    if (!injectResult.ok) {
      logTistoryPublishMarker(logger, { ok: false, reason: 'editor_fill_failed', detail: injectResult.reason });
      logger.result(RESULT.FAILED, 'editor_fill_failed');
      return EXIT.FAILED;
    }

    logTistoryPublishMarker(logger, {
      ok: true,
      status: 'editor_filled',
      bodyLen: finalHtml.length,
    });

    let coverDataUrl = '';

    // 만약 withImages 옵션이 켜져있다면, 제미나이를 이용해 이미지를 실시간으로 생성하여 주입
    if (args.withImages) {
      logger.info('[TISTORY] 이미지 실시간 생성 플로우를 시작합니다 (네이버 매칭 방식)...');
      try {
        const placeholders = extractImagePlaceholders(finalHtml);
        const resolvedTitle = extractFirstH1PlainTextFromHtml(finalHtml) || title || '블로그 대표 이미지';

        // 대표 이미지(썸네일)도 큐에 등록
        placeholders.push({
          imageInnerPrompt: `${resolvedTitle} 주제를 잘 나타내는 아주 멋진 일러스트레이션`,
          fullPlaceholderLine: '썸네일 삽입 공간',
          prompt: `${resolvedTitle} 주제를 잘 나타내는 아주 멋진 일러스트레이션`,
          isVirtualCover: true
        });

        logger.info(`[TISTORY] 총 ${placeholders.length}개의 이미지 생성 대기열이 확인되었습니다.`);

        const geminiSession = await runGeminiSessionFromProfile({
          url: DEFAULT_GEMINI_URL,
          profileDir: GEMINI_PROFILE_DIR,
          logger,
        });

        if (geminiSession) {
          for (let i = 0; i < placeholders.length; i++) {
            const ph = placeholders[i];
            logger.info(`[TISTORY] [IMAGE_GEN] 이미지 생성 중 (${i + 1}/${placeholders.length}) - 프롬프트: "${ph.prompt.slice(0, 50)}..."`);
            
            // 새 채팅 페이지로 이동하여 안전성 확보
            await geminiSession.page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded' }).catch(() => {});
            await sleep(2500);

            const styleFile = path.resolve(process.cwd(), 'src/lib/prompts/gemini-image-style.txt');
            let styleSuffix = '';
            if (fs.existsSync(styleFile)) {
              styleSuffix = fs.readFileSync(styleFile, 'utf8').replace(/^={10,}[\s\S]*?={10,}\r?\n?/, '').trim();
            }
            const fullPrompt = `주제: ${ph.prompt}\n스타일: ${styleSuffix || '3D 일러스트'}`;

            const imageResult = await runGeminiImageGenerationWithRestarts(geminiSession.page, geminiSession.context, fullPrompt, logger);

            if (imageResult.ok && imageResult.dataUrl) {
              if (ph.isVirtualCover) {
                coverDataUrl = imageResult.dataUrl;
                logger.info(`[TISTORY] 대표 이미지(썸네일) 생성 완료! (커버 이미지로만 사용)`);
              } else {
                logger.info(`[TISTORY] 본문 이미지 생성 완료!`);
                await pasteImageAtPlaceholder(page, imageResult.dataUrl, ph.fullPlaceholderLine, logger, {
                  queueIndex: i,
                  queueTotal: placeholders.length,
                });
              }
            } else {
              logger.error(`[TISTORY] 이미지 생성 실패: ${imageResult.reason}`);
            }
            await sleep(2000);
          }
          await geminiSession.context.close().catch(() => {});
        } else {
          logger.warn('[TISTORY] 이미지 생성을 위한 제미나이 세션 구동에 실패했습니다.');
        }
      } catch (imgError) {
        logger.error(`[TISTORY] 이미지 자동 생성 중 에러 발생: ${imgError.message}`);
      }
    } else if (args.images && Array.isArray(args.images) && args.images.length > 0) {
      // 로컬 이미지 주입 로직
      logger.info(`[TISTORY] 로컬 이미지 ${args.images.length}개를 직접 삽입합니다...`);

      let thumbImage = args.images.find(img => img.type === 'thumbnail') || args.images[0];
      let bodyImages = args.images.filter(img => img !== thumbImage);

      if (thumbImage && thumbImage.localPath && fs.existsSync(thumbImage.localPath)) {
        logger.info(`[TISTORY] 대표 이미지(썸네일) 설정 완료 (커버 이미지로만 사용)...`);
        const base64 = fs.readFileSync(thumbImage.localPath, 'base64');
        const dataUrl = 'data:image/png;base64,' + base64;
        coverDataUrl = dataUrl;
      }

      for (let i = 0; i < bodyImages.length; i++) {
        const bImg = bodyImages[i];
        if (bImg.localPath && fs.existsSync(bImg.localPath) && bImg.marker) {
          logger.info(`[TISTORY] 본문 이미지 삽입 중... (${i + 1}/${bodyImages.length})`);
          const base64 = fs.readFileSync(bImg.localPath, 'base64');
          const dataUrl = 'data:image/png;base64,' + base64;
          await pasteImageAtPlaceholder(page, dataUrl, bImg.marker, logger, {
            queueIndex: i,
            queueTotal: bodyImages.length,
          });
        }
      }
    }

    // 최종 발행 버튼 클릭 및 URL 획득
    logger.info('티스토리 포스팅 최종 발행 진행 중...');
    const publishResult = await publishTistoryPostAfterGate(
      page,
      finalHtml,
      {
        isPublic: args.visibility === '2',
        visibility: args.visibility,
        blogUrl: args.blogUrl,
        categoryItemElementId: args.category || '',
        coverDataUrl,
      },
      logger
    );

    if (!publishResult.ok) {
      logTistoryPublishMarker(logger, { ok: false, reason: 'public_publish_failed' });
      logger.result(RESULT.FAILED, 'public_publish_failed');
      return EXIT.FAILED;
    }

    logTistoryPublishMarker(logger, { ok: true, status: 'public_published', url: publishResult.publishedUrl });
    logger.result(RESULT.SUCCESS, 'Tistory public publish completed');
    await sleep(POST_SUCCESS_HOLD_MS);
    return EXIT.SUCCESS;

  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logTistoryPublishMarker(logger, { ok: false, reason: 'browser_error', message: detail });
    logger.error(detail);
    logger.result(RESULT.FAILED, 'browser_error');
    return EXIT.FAILED;
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

async function tryDismissDraftPopup(page, logger) {
  try {
    await dismissTistoryDraftResumePopup(page, logger, { quick: true });
  } catch {
    /* ignore */
  }
}

module.exports = {
  run,
};
