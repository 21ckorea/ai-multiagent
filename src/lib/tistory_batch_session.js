'use strict';

/**
 * @file tistory_batch_session.js
 * @description 티스토리 배치 세션 홀더 (브라우저 재활용)
 * @purpose  배치 발행 시 매번 새 브라우저를 띄우지 않고 하나의 Playwright 브라우저를
 *           세션 동안 재활용하여 속도와 안정성을 높임.
 * @exports  createTistoryBatchSessionHolder, closeTistoryBatchSession
 * @seeAlso  batch_publish.js, playwright_tistory_login.js
 */


const { enableJsDialogAutoDismiss } = require('./tistory_dialog');
const {
  findPageOnNewPost,
  launchTistoryContext,
  navigatePageToNewPost,
  runPublishLogin,
  safePageUrl,
} = require('./playwright_tistory_login');
const { resolvePublishTabPolicy } = require('./tistory_tab_policy');
const { isOnTistoryNewPost, isOnTistorySite } = require('./tistory_common');

/**
 * Mutable holder for batch-level Tistory browser reuse.
 * @returns {{ context: null, editorPage: null, launchPage: null, dialogSessions: [], tabPolicy: object }}
 */
function createTistoryBatchSessionHolder() {
  return {
    context: null,
    editorPage: null,
    launchPage: null,
    dialogSessions: [],
    tabPolicy: resolvePublishTabPolicy(),
  };
}

/**
 * Navigate an already-logged-in profile to /manage/newpost without closing hub tabs.
 *
 * @param {object} params
 * @returns {Promise<{ ok: boolean, page?: import('playwright').Page, url?: string, reason?: string }>}
 */
async function reuseTistorySessionForNewPost({
  holder,
  newPostUrl,
  tistoryArgs,
  logger,
}) {
  const context = holder?.context;
  if (!context) {
    return { ok: false, reason: 'no_context' };
  }

  let page = holder.editorPage;
  if (!page) {
    const found = findPageOnNewPost(context, holder.launchPage);
    page = found?.page ?? null;
  }

  if (!page) {
    for (const candidate of context.pages()) {
      const url = safePageUrl(candidate);
      if (isOnTistorySite(url) || isOnTistoryNewPost(url)) {
        page = candidate;
        break;
      }
    }
  }

  if (!page) {
    page = holder.launchPage || context.pages()[0];
  }

  if (!page) {
    return { ok: false, reason: 'no_page' };
  }

  try {
    await page.bringToFront();
  } catch {
    /* ignore */
  }

  const dialogSession = await enableJsDialogAutoDismiss(page, context, logger).catch(() => null);
  if (dialogSession) {
    holder.dialogSessions.push(dialogSession);
  }

  const nav = await navigatePageToNewPost(page, newPostUrl, logger);
  if (nav?.ok) {
    holder.editorPage = nav.page;
    logger?.info?.(
      `[Tistory] [SESSION] batch reuse: newpost via existing tab (${safePageUrl(nav.page).slice(0, 100)}) openTabs=${context.pages().length}`,
    );
    return { ok: true, page: nav.page, url: nav.url };
  }

  logger?.info?.(
    `[Tistory] [SESSION] batch reuse navigate failed url=${safePageUrl(page).slice(0, 100)} — full login fallback`,
  );
  return { ok: false, reason: 'reuse_nav_failed', page };
}

/**
 * @param {object} params
 * @returns {Promise<{ ok: boolean, page?: import('playwright').Page, url?: string, reason?: string, detail?: string }>}
 */
async function ensureTistoryBatchLogin({
  holder,
  newPostUrl,
  tistoryArgs,
  logger,
}) {
  if (holder?.context && holder.editorPage) {
    const reuse = await reuseTistorySessionForNewPost({
      holder,
      newPostUrl,
      tistoryArgs,
      logger,
    });
    if (reuse.ok) {
      return reuse;
    }
  }

  if (!holder.context) {
    const launched = await launchTistoryContext(tistoryArgs.profileDir, logger);
    holder.context = launched.context;
    holder.launchPage = launched.page;
    holder.editorPage = launched.page;
    if (launched.dialogSession) {
      holder.dialogSessions.push(launched.dialogSession);
    }
    logger?.info?.('[Tistory] [SESSION] batch: launched persistent context');
  }

  const loginOutcome = await runPublishLogin(
    holder.launchPage || holder.editorPage || holder.context.pages()[0],
    tistoryArgs,
    newPostUrl,
    logger,
    holder.context,
    holder.dialogSessions,
    holder.tabPolicy,
  );

  if (!loginOutcome.ok) {
    return loginOutcome;
  }

  holder.editorPage = loginOutcome.page || holder.editorPage;
  logger?.info?.(
    `[Tistory] [SESSION] batch login complete openTabs=${holder.context.pages().length}`,
  );
  return {
    ok: true,
    page: holder.editorPage,
    url: loginOutcome.url,
  };
}

module.exports = {
  createTistoryBatchSessionHolder,
  reuseTistorySessionForNewPost,
  ensureTistoryBatchLogin,
};
