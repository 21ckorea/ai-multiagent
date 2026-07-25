'use strict';

/**
 * @file playwright_tistory_login.js
 * @description 티스토리 Playwright 로그인 자동화
 * @purpose  티스토리(카카오 OAuth) 로그인을 Playwright로 자동화하고,
 *           프로필 디렉토리에 세션을 저장해 이후 재로그인 없이 재사용.
 * @exports  loginTistoryWithPlaywright, closeTistoryContext
 * @seeAlso  kakao_login.js, playwright_gemini_tistory_pipeline.js
 */


const { chromium } = require('playwright');
const {
  POST_SUCCESS_HOLD_MS,
  VERIFY_SUCCESS_HOLD_MS,
  EXIT,
  RESULT,
  createLogger,
  sleep,
  CHROME_STEALTH_ARGS,
  PLAYWRIGHT_STEALTH_IGNORE_DEFAULT_ARGS,
  applyPlaywrightStealthInitScript,
} = require('./common');
const {
  parseTistoryArgs,
  validateTistoryArgs,
  normalizeFailureReason,
  harvestFailureReason,
  TISTORY_ERROR,
  TISTORY_LOGIN_TIMEOUT_MS,
  TISTORY_URL_POLL_INTERVAL_MS,
  TISTORY_PAGE_LOAD_TIMEOUT_MS,
  sameBlogHostname,
  isOnTistoryNewPost,
  isOnKakaoLogin,
  isOnTistorySite,
  isSessionExpiredRedirect,
  logHandoffJsonLine,
  resolveKakaoLoginUrl,
} = require('./tistory_common');
const { harvestCategories, logCategoriesJsonLines } = require('./tistory_category_harvest');
const {
  scheduleKakaoAutofill,
  startKakaoErrorWatch,
  fillAndSubmit,
  isKakaoAuthUrl,
  isKakaoLoginPage,
  isKakaoOAuthAuthorizeUrl,
  maybeLogKakaoOAuthManualWait,
  waitForKakaoPostSubmitNavigation,
} = require('./kakao_login');
const { enableJsDialogAutoDismiss, disposeDialogSessions } = require('./tistory_dialog');
const { dismissTistoryDraftResumePopup } = require('./tistory_draft_resume');
const {
  DEFAULT_PUBLISH_TAB_POLICY,
  resolvePublishTabPolicy,
} = require('./tistory_tab_policy');
const { TISTORY_EDITOR_LEGACY_SETTLE_MS } = require('./tistory_editor_inject');

const ENGINE = 'Playwright';

function fail(logger, reason, detail, password) {
  const code = normalizeFailureReason(reason);
  const suffix = detail ? ` — ${detail}` : '';
  logger.result(RESULT.FAILED, `${code}${suffix}`);
  return EXIT.FAILED;
}

function safePageUrl(page) {
  try {
    return page.url();
  } catch {
    return '';
  }
}

function findPageOnNewPost(context, fallbackPage) {
  const pages = context?.pages?.() ?? [fallbackPage];
  for (const candidate of pages) {
    const url = safePageUrl(candidate);
    if (isOnTistoryNewPost(url)) {
      return { page: candidate, url };
    }
  }
  return null;
}

async function waitForNewPostPageReady(page, logger) {
  try {
    await page.waitForURL(/\/manage\/newpost/i, { timeout: 30000 });
    logger.info(`[TistoryLogin] newpost URL confirmed: ${safePageUrl(page).slice(0, 120)}`);
  } catch (error) {
    logger.info(
      `[TistoryLogin] waitForURL newpost timeout: ${error instanceof Error ? error.message : String(error)} url=${safePageUrl(page).slice(0, 120)}`,
    );
  }
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 20000 });
  } catch {
    /* dialog dismiss may delay load event; continue */
  }
}

async function navigatePageToNewPost(page, newPostUrl, logger) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      logger.info(`Navigating to newpost (attempt ${attempt}): ${newPostUrl}`);
      const response = await page.goto(newPostUrl, {
        waitUntil: 'commit',
        timeout: TISTORY_PAGE_LOAD_TIMEOUT_MS,
      });
      logger.info(
        `[TistoryLogin] newpost goto commit done status=${response?.status?.() ?? 'n/a'} url=${safePageUrl(page).slice(0, 120)}`,
      );
      await waitForNewPostPageReady(page, logger);
      await dismissTistoryDraftResumePopup(page, logger, { quick: true });
      try {
        await page.waitForSelector('#category-btn', { timeout: 20000 });
        logger.info('[TistoryLogin] #category-btn visible');
      } catch {
        logger.info('Category button not visible yet; continuing (digest-only may still succeed).');
      }
      await dismissTistoryDraftResumePopup(page, logger, { quick: true });
      const url = safePageUrl(page);
      if (isOnTistoryNewPost(url)) {
        logger.info(`Reached newpost editor: ${url}`);
        return { ok: true, url, page };
      }
      logger.info(`Newpost navigation landed on: ${url}`);
      if (isSessionExpiredRedirect(url)) {
        break;
      }
    } catch (error) {
      logger.info(
        `Newpost navigation error: ${error instanceof Error ? error.message : String(error)}`,
      );
      break;
    }
  }
  return null;
}

async function closeHubTabIfSafe(pageToClose, keepPage, logger, tabPolicy = DEFAULT_PUBLISH_TAB_POLICY) {
  if (!pageToClose || pageToClose === keepPage) {
    return;
  }
  const policy = resolvePublishTabPolicy(tabPolicy);
  if (!policy.closeHubTabAfterNewpost) {
    logger.info(
      `[TistoryLogin] keeping tab open (${safePageUrl(pageToClose).slice(0, 80)}) — publish session reuse`,
    );
    return;
  }
  try {
    await pageToClose.close();
    logger.info('Closed hub/login tab after newpost (explicit tab policy).');
  } catch (error) {
    logger.info(
      `Could not close hub tab: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Legacy parity — jably_blog background.js opens a fresh tab to newPostUrl
 * once any tistory.com page loads after Kakao login.
 */
async function openLegacyNewPostTab(context, newPostUrl, logger) {
  logger.info('Opening newpost in a fresh tab (legacy VERIFY_TISTORY_LOGIN parity)...');
  const editorPage = await context.newPage();
  const editorDialogSession = await enableJsDialogAutoDismiss(editorPage, context, logger).catch(
    () => null,
  );
  return {
    editorPage,
    editorDialogSession,
    outcome: await navigatePageToNewPost(editorPage, newPostUrl, logger),
  };
}

/**
 * www.tistory.com hub → new tab newpost first (legacy), then same-tab fallback.
 */
async function advanceFromTistoryHub(activePage, context, newPostUrl, logger, state) {
  const hubUrl = safePageUrl(activePage);
  const tabPolicy = resolvePublishTabPolicy(state.tabPolicy);
  logger.info(`Tistory hub detected (${hubUrl}). Moving to newpost: ${newPostUrl}`);

  if (tabPolicy.preferSameTabNewpostNavigation) {
    const sameTabOutcome = await navigatePageToNewPost(activePage, newPostUrl, logger);
    if (sameTabOutcome?.ok) {
      logger.info(
        `[TistoryLogin] newpost via same-tab navigation (hub kept, openTabs=${context?.pages?.()?.length ?? 1})`,
      );
      return sameTabOutcome;
    }
    logger.info('[TistoryLogin] same-tab newpost navigation failed; trying new-tab fallback');
  }

  if (context && !state.legacyNewPostTabOpened) {
    state.legacyNewPostTabOpened = true;
    const { editorPage, editorDialogSession, outcome } = await openLegacyNewPostTab(
      context,
      newPostUrl,
      logger,
    );
    if (editorDialogSession && Array.isArray(state.dialogSessions)) {
      state.dialogSessions.push(editorDialogSession);
    }
    if (outcome) {
      await closeHubTabIfSafe(activePage, outcome.page, logger, tabPolicy);
      return outcome;
    }
    try {
      await editorPage.bringToFront();
    } catch {
      // ignore
    }
    const retry = await navigatePageToNewPost(editorPage, newPostUrl, logger);
    if (retry) {
      await closeHubTabIfSafe(activePage, retry.page, logger, tabPolicy);
      return retry;
    }
  }

  const sameTabOutcome = await navigatePageToNewPost(activePage, newPostUrl, logger);
  if (sameTabOutcome) {
    return sameTabOutcome;
  }

  if (context) {
    for (const candidate of context.pages()) {
      const candidateUrl = safePageUrl(candidate);
      if (!isOnTistorySite(candidateUrl) && !isOnTistoryNewPost(candidateUrl)) {
        continue;
      }
      const nav = await navigatePageToNewPost(candidate, newPostUrl, logger);
      if (nav) {
        return nav;
      }
    }
  }

  return null;
}

async function waitForNewPost(page, newPostUrl, errorWatch, logger, credentials, context, pollState = {}) {
  const deadline = Date.now() + TISTORY_LOGIN_TIMEOUT_MS;
  let activePage = page;
  const state = {
    legacyNewPostTabOpened: false,
    oauthHintLogged: false,
    kakaoLoginSubmitted: pollState.kakaoLoginSubmitted === true,
    dialogSessions: pollState.dialogSessions ?? null,
    tabPolicy: pollState.tabPolicy ?? DEFAULT_PUBLISH_TAB_POLICY,
  };

  while (Date.now() < deadline) {
    const reached = findPageOnNewPost(context, activePage);
    if (reached) {
      logger.info(
        `[TistoryLogin] newpost reached (${reached.url.slice(0, 120)}) — editor settle ${TISTORY_EDITOR_LEGACY_SETTLE_MS}ms`,
      );
      await dismissTistoryDraftResumePopup(reached.page, logger, { quick: true });
      try {
        await reached.page.waitForTimeout(TISTORY_EDITOR_LEGACY_SETTLE_MS);
      } catch {
        await sleep(TISTORY_EDITOR_LEGACY_SETTLE_MS);
      }
      try {
        await reached.page
          .locator('#editor-mode-layer-btn-open')
          .first()
          .waitFor({ state: 'visible', timeout: 15000 });
        logger.info('[TistoryLogin] editor mode button visible after newpost landing');
      } catch {
        logger.info(
          '[TistoryLogin] editor mode button not visible after settle (inject phase will retry)',
        );
      }
      return { ok: true, url: reached.url, page: reached.page };
    }

    const kakaoError = errorWatch.getError();
    if (kakaoError) {
      const line = kakaoError.split('\n')[0].slice(0, 220);
      return { ok: false, reason: TISTORY_ERROR.KAKAO_LOGIN_ERROR, detail: line };
    }

    const url = safePageUrl(activePage);
    if (url) {
      logger.info(`Poll URL: ${url.slice(0, 160)}`);
    }

    if (isOnTistorySite(url) && !isOnTistoryNewPost(url)) {
      const outcome = await advanceFromTistoryHub(
        activePage,
        context,
        newPostUrl,
        logger,
        state,
      );
      if (outcome) {
        return outcome;
      }
      if (context && context.pages().length > 1) {
        activePage = context.pages()[context.pages().length - 1];
      }
      await activePage.waitForTimeout(TISTORY_URL_POLL_INTERVAL_MS);
      continue;
    }

    if (isOnKakaoLogin(url) || isKakaoLoginPage(url)) {
      if (state.kakaoLoginSubmitted) {
        logger.info('Kakao login already submitted; waiting for redirect...');
        await waitForKakaoPostSubmitNavigation(activePage, logger, 5000).catch(() => {});
      } else if (credentials) {
        const fillResult = await fillAndSubmit(
          activePage,
          credentials.kakaoId,
          credentials.kakaoPassword,
          logger,
        );
        if (fillResult.ok && fillResult.submitted) {
          state.kakaoLoginSubmitted = true;
          logger.info('Kakao autofill submitted during URL poll.');
          await waitForKakaoPostSubmitNavigation(activePage, logger).catch(() => {});
        } else if (fillResult.reason === 'kakao_navigating') {
          state.kakaoLoginSubmitted = true;
        } else if (fillResult.reason && !fillResult.skipped) {
          logger.info(`Kakao fill retry during poll: ${fillResult.reason}`);
        }
      }
      await activePage.waitForTimeout(TISTORY_URL_POLL_INTERVAL_MS);
      continue;
    }

    if (isKakaoOAuthAuthorizeUrl(url)) {
      maybeLogKakaoOAuthManualWait(url, logger, state);
      await activePage.waitForTimeout(TISTORY_URL_POLL_INTERVAL_MS);
      continue;
    }

    if (context) {
      for (const candidate of context.pages()) {
        const candidateUrl = safePageUrl(candidate);
        if (isOnTistoryNewPost(candidateUrl)) {
          return { ok: true, url: candidateUrl, page: candidate };
        }
        if (isOnTistorySite(candidateUrl) && candidate !== activePage) {
          activePage = candidate;
          break;
        }
      }
    }

    await activePage.waitForTimeout(TISTORY_URL_POLL_INTERVAL_MS);
  }

  return { ok: false, reason: TISTORY_ERROR.KAKAO_LOGIN_TIMEOUT };
}

async function runPublishLogin(
  page,
  args,
  newPostUrl,
  logger,
  context,
  dialogSessions = [],
  tabPolicy = DEFAULT_PUBLISH_TAB_POLICY,
) {
  const errorWatch = startKakaoErrorWatch(page, logger);
  const kakaoLoginUrl = resolveKakaoLoginUrl(args.kakaoLoginUrl);

  try {
    logger.info(`Navigating to Kakao login: ${kakaoLoginUrl.slice(0, 80)}...`);
    await page.goto(kakaoLoginUrl, {
      waitUntil: 'domcontentloaded',
      timeout: TISTORY_PAGE_LOAD_TIMEOUT_MS,
    });
    await page.waitForTimeout(600);

    const pollState = {
      kakaoLoginSubmitted: false,
      dialogSessions,
      tabPolicy: resolvePublishTabPolicy(tabPolicy),
    };
    const autofillResult = await scheduleKakaoAutofill(page, args.kakaoId, args.kakaoPassword, logger);
    if (autofillResult.ok && autofillResult.submitted) {
      pollState.kakaoLoginSubmitted = true;
      logger.info('Initial Kakao autofill submitted.');
      await waitForKakaoPostSubmitNavigation(page, logger).catch(() => {});
    } else if (!autofillResult.skipped) {
      logger.info(
        `Initial Kakao autofill incomplete: ${autofillResult.reason || 'unknown'}. Will retry during URL poll.`,
      );
    }

    const outcome = await waitForNewPost(page, newPostUrl, errorWatch, logger, args, context, pollState);
    if (!outcome.ok) {
      return outcome;
    }

    return { ok: true, url: outcome.url, page: outcome.page || page };
  } finally {
    errorWatch.stop();
  }
}

async function runVerifyLogin(page, args, newPostUrl, logger, context, dialogSessions = []) {
  const publishOutcome = await runPublishLogin(
    page,
    args,
    newPostUrl,
    logger,
    context,
    dialogSessions,
  );
  if (!publishOutcome.ok) {
    return publishOutcome;
  }

  const editorPage = publishOutcome.page || page;
  const url = safePageUrl(editorPage);
  if (!sameBlogHostname(url, newPostUrl)) {
    return { ok: false, reason: TISTORY_ERROR.INVALID_BLOG_URL };
  }

  logger.info('Harvesting Tistory categories...');
  const harvest = await harvestCategories(editorPage, logger);
  logCategoriesJsonLines(logger, harvest);
  const categoryCount =
    harvest?.ok && Array.isArray(harvest.items) ? harvest.items.length : 0;
  if (harvestFailureReason(harvest)) {
    logger.info(
      `Verify complete; digest-only success (categories not harvested: ${harvest?.error || 'unknown'})`,
    );
  } else {
    logger.info(`Verify complete; categories=${categoryCount}`);
  }
  return { ok: true, url, page: editorPage, categories: categoryCount };
}

async function runRefresh(page, newPostUrl, logger) {
  logger.info('Refresh mode: Kakao credentials not required.');
  logger.info(`Reusing persistent profile session → ${newPostUrl}`);
  await page.goto(newPostUrl, {
    waitUntil: 'domcontentloaded',
    timeout: TISTORY_PAGE_LOAD_TIMEOUT_MS,
  });
  await page.waitForTimeout(1500);

  const url = page.url();
  if (isSessionExpiredRedirect(url) || isOnKakaoLogin(url) || isKakaoAuthUrl(url)) {
    logger.info(`Session expired: login redirect detected (${url})`);
    return { ok: false, reason: TISTORY_ERROR.SESSION_EXPIRED };
  }

  if (!isOnTistoryNewPost(url)) {
    if (isOnTistorySite(url)) {
      await page.goto(newPostUrl, {
        waitUntil: 'domcontentloaded',
        timeout: TISTORY_PAGE_LOAD_TIMEOUT_MS,
      });
      await page.waitForTimeout(1500);
    }
  }

  const finalUrl = page.url();
  if (isSessionExpiredRedirect(finalUrl) || isOnKakaoLogin(finalUrl) || isKakaoAuthUrl(finalUrl)) {
    logger.info(`Session expired: login redirect detected (${finalUrl})`);
    return { ok: false, reason: TISTORY_ERROR.SESSION_EXPIRED };
  }
  if (!isOnTistoryNewPost(finalUrl)) {
    logger.info(`Session expired: expected newpost, got ${finalUrl}`);
    return { ok: false, reason: TISTORY_ERROR.SESSION_EXPIRED };
  }

  if (!sameBlogHostname(finalUrl, newPostUrl)) {
    return { ok: false, reason: TISTORY_ERROR.INVALID_BLOG_URL };
  }

  const harvest = await harvestCategories(page, logger);
  const harvestReason = harvestFailureReason(harvest);
  if (harvestReason) {
    return { ok: false, reason: harvestReason };
  }

  logCategoriesJsonLines(logger, harvest);
  logger.info(`Category refresh complete; categories=${harvest.items.length}`);
  return { ok: true, url: finalUrl, categories: harvest.items.length };
}

async function runMode(page, args, newPostUrl, logger, context, dialogSessions = []) {
  switch (args.mode) {
    case 'verify':
      return runVerifyLogin(page, args, newPostUrl, logger, context, dialogSessions);
    case 'refresh':
      return runRefresh(page, newPostUrl, logger);
    case 'publish':
    default:
      return runPublishLogin(
        page,
        args,
        newPostUrl,
        logger,
        context,
        dialogSessions,
        DEFAULT_PUBLISH_TAB_POLICY,
      );
  }
}

async function launchTistoryContext(profileDir, logger, isHeadless = false) {
  logger.info('Launching persistent Chrome context (headless: false)...');
  logger.info(`Profile directory: ${profileDir}`);
  logger.info('Applying stealth launch flags (AutomationControlled mitigation).');

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: isHeadless,
    channel: 'chrome',
    args: CHROME_STEALTH_ARGS,
    ignoreDefaultArgs: PLAYWRIGHT_STEALTH_IGNORE_DEFAULT_ARGS,
  });

  await applyPlaywrightStealthInitScript(context);

  const page = context.pages()[0] || (await context.newPage());
  const dialogSession = await enableJsDialogAutoDismiss(page, context, logger);
  logger.info('Browser launched.');
  return { context, page, dialogSession };
}

async function closeTistoryContext(context, logger, password, exitCode, options = {}) {
  if (!context) {
    return exitCode;
  }

  const immediate = options.immediate === true;
  const holdMs = immediate
    ? 0
    : (options.holdMs != null ? options.holdMs : POST_SUCCESS_HOLD_MS);

  const sessions = [];
  if (Array.isArray(options.dialogSessions)) {
    sessions.push(...options.dialogSessions);
  }
  if (options.dialogSession) {
    sessions.push(options.dialogSession);
  }
  await disposeDialogSessions(sessions, logger);

  if (holdMs > 0) {
    logger.info(`Holding browser open for ${holdMs / 1000} seconds before closing...`);
    try {
      const page = context.pages()[0];
      if (page) {
        await page.waitForTimeout(holdMs);
      } else {
        await sleep(holdMs);
      }
    } catch {
      await sleep(holdMs);
    }
  } else {
    logger.info('Fast-close: skipping post-success hold (abort/batch cleanup).');
  }

  await context.close().catch((closeError) => {
    logger.error(
      closeError instanceof Error ? closeError.message : String(closeError),
      password,
    );
  });
  logger.info('Browser closed.');
  return exitCode;
}

async function run() {
  const args = parseTistoryArgs();
  const logger = createLogger(ENGINE);
  let context = null;
  let exitCode = EXIT.SUCCESS;
  const dialogSessions = [];

  logger.info(`Mode: ${args.mode}`);
  logger.info(`Blog URL: ${args.blogUrl || '(empty)'}`);
  if (args.mode === 'refresh') {
    logger.info('Refresh mode: only --blog-url is required (Kakao args ignored).');
  }

  const validation = validateTistoryArgs(args);
  if (!validation.ok) {
    exitCode = fail(logger, validation.reason, '', args.kakaoPassword);
    return;
  }

  const newPostUrl = validation.newPostUrl;
  logger.info(`Target newpost: ${newPostUrl}`);
  logger.info('Launching persistent Chrome context (headless: false)...');
  logger.info(`Profile directory: ${args.profileDir}`);
  logger.info('Applying stealth launch flags (AutomationControlled mitigation).');

  try {
    const { context: launchedContext, page, dialogSession } = await launchTistoryContext(
      args.profileDir,
      logger,
    );
    context = launchedContext;
    if (dialogSession) {
      dialogSessions.push(dialogSession);
    }

    const outcome = await runMode(page, args, newPostUrl, logger, context, dialogSessions);

    if (outcome.ok) {
      const editorPage = outcome.page || context.pages()[0] || page;
      if (args.mode === 'verify') {
        logger.result(RESULT.SUCCESS, `Verify complete; categories=${outcome.categories ?? 0}`);
      } else if (args.mode === 'refresh') {
        logger.result(RESULT.SUCCESS, `Category refresh; categories=${outcome.categories ?? 0}`);
      } else {
        const finalUrl = outcome.url || safePageUrl(editorPage) || newPostUrl;
        logHandoffJsonLine(logger, {
          newPostUrl,
          finalUrl,
          profileDir: args.profileDir,
        });
        logger.result(RESULT.SUCCESS, 'Reached /manage/newpost');
      }
      exitCode = EXIT.SUCCESS;
    } else {
      exitCode = fail(logger, outcome.reason, outcome.detail, args.kakaoPassword);
    }
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error), args.kakaoPassword);
    logger.result(RESULT.FAILED, 'browser_error');
    exitCode = EXIT.FAILED;
  } finally {
    const isVerifyOrRefresh = args.mode === 'verify' || args.mode === 'refresh';
    exitCode = await closeTistoryContext(context, logger, args.kakaoPassword, exitCode, {
      holdMs: isVerifyOrRefresh ? VERIFY_SUCCESS_HOLD_MS : undefined,
      dialogSessions,
    });
    process.exitCode = exitCode;
  }
}

if (require.main === module) {
  run()
    .catch((error) => {
      const logger = createLogger(ENGINE);
      const args = parseTistoryArgs();
      logger.error(error instanceof Error ? error.message : String(error), args.kakaoPassword);
      logger.result(RESULT.FAILED, 'Unhandled script error.');
      process.exitCode = EXIT.FAILED;
    })
    .finally(() => {
      process.exit(process.exitCode ?? EXIT.SUCCESS);
    });
}

module.exports = {
  run,
  launchTistoryContext,
  closeTistoryContext,
  runPublishLogin,
  runMode,
  waitForNewPost,
  navigatePageToNewPost,
  openLegacyNewPostTab,
  advanceFromTistoryHub,
  findPageOnNewPost,
  safePageUrl,
};
