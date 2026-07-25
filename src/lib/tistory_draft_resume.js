'use strict';

/**
 * @file tistory_draft_resume.js
 * @description 티스토리 임시저장 글 재개 처리
 * @purpose  이전에 임시저장된 포스트가 있을 경우 이를 감지하고
 *           새 글 작성을 위해 임시저장 다이얼로그를 적절히 처리.
 * @exports  handleTistoryDraftResume
 * @seeAlso  tistory_editor_inject.js, playwright_tistory_login.js
 */


/**
 * Dismiss "작성 중인 글이 있습니다" resume popup on /manage/newpost (legacy: click 취소).
 * Handles SmartEditor DOM popups (Naver parity) and complements native dialog dismiss in tistory_dialog.js.
 */

const DRAFT_RESUME_DISMISS_GAPS_MS = [200, 400, 700, 1200, 2000, 3500, 5000, 8000, 10000];
const DRAFT_RESUME_DISMISS_GAPS_QUICK_MS = [200, 500, 1200, 2000];

/** Native confirm/alert message on newpost when autosaved draft exists. */
const DRAFT_RESUME_DIALOG_MESSAGE_RE =
  /작성\s*중인\s*글|임시\s*저장|이어서\s*작성|저장된\s*글|에\s*저장된\s*글|작성\s*중인\s*내용|불러오시겠/i;

/** Visible popup title/body (SmartEditor layer). */
const DRAFT_RESUME_POPUP_TEXT_RE =
  /작성\s*중인\s*글이\s*있습니다|임시\s*저장된\s*글|저장된\s*글이\s*있습니다|이어서\s*작성/i;

/**
 * @param {string} message
 * @returns {boolean} true → dismiss (Cancel), false → accept (OK)
 */
function isDraftResumeDialogMessage(message) {
  const m = String(message ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!m) {
    return false;
  }
  return DRAFT_RESUME_DIALOG_MESSAGE_RE.test(m);
}

/**
 * Injected in MAIN world (all frames). Self-contained for page.evaluate.
 * @returns {{ clicked: boolean, via?: string, reason?: string }}
 */
function tistoryDraftResumeDismissMain() {
  const normalize = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  function clickCancelInRoot(root) {
    if (!root || !DRAFT_RESUME_POPUP_TEXT_RE.test(normalize(root.textContent))) {
      return null;
    }
    const cancelBtn =
      root.querySelector('button.se-popup-button-cancel') ||
      root.querySelector('.se-popup-button-cancel') ||
      root.querySelector('button.btn_cancel') ||
      root.querySelector('.btn_cancel') ||
      [...root.querySelectorAll('button, a[role="button"], [role="button"]')].find((el) => {
        const t = normalize(el.textContent);
        return t === '취소' || /^cancel$/i.test(t);
      });
    if (!cancelBtn) {
      return { clicked: false, reason: 'no_cancel_button' };
    }
    try {
      cancelBtn.focus?.();
      cancelBtn.click?.();
    } catch {
      return { clicked: false, reason: 'click_failed' };
    }
    return { clicked: true, via: 'dom_cancel' };
  }

  const popupSelectors = [
    '.se-popup-container.__se-pop-layer',
    '.se-popup-container',
    '.layer_popup',
    '.mce-window',
    '[role="dialog"]',
    '.dialog_layer',
  ];
  for (const sel of popupSelectors) {
    const nodes = document.querySelectorAll(sel);
    for (const node of nodes) {
      const hit = clickCancelInRoot(node);
      if (hit?.clicked) {
        return { ...hit, frameHref: location.href || '' };
      }
    }
  }

  const bodies = document.querySelectorAll('p, h1, h2, h3, .se-popup-title, .tit_popup');
  for (const el of bodies) {
    if (!DRAFT_RESUME_POPUP_TEXT_RE.test(normalize(el.textContent))) {
      continue;
    }
    let root = el.parentElement;
    for (let depth = 0; depth < 12 && root; depth += 1) {
      const hit = clickCancelInRoot(root);
      if (hit?.clicked) {
        return { ...hit, via: 'dom_cancel_ancestor', frameHref: location.href || '' };
      }
      root = root.parentElement;
    }
  }

  return { clicked: false, reason: 'no_popup' };
}

/**
 * @param {import('playwright').Page} page
 * @param {object} [logger]
 * @param {{ quick?: boolean }} [options]
 * @returns {Promise<boolean>}
 */
async function dismissTistoryDraftResumePopup(page, logger, options = {}) {
  if (!page) {
    return false;
  }

  const gaps = options.quick ? DRAFT_RESUME_DISMISS_GAPS_QUICK_MS : DRAFT_RESUME_DISMISS_GAPS_MS;

  for (let attempt = 0; attempt < gaps.length; attempt += 1) {
    const gap = gaps[attempt];
    try {
      await page.waitForTimeout(gap);
    } catch {
      await new Promise((r) => setTimeout(r, gap));
    }

    const frames = typeof page.frames === 'function' ? page.frames() : [page.mainFrame?.() ?? page];
    for (const frame of frames) {
      if (!frame) {
        continue;
      }
      try {
        const result = await frame.evaluate(tistoryDraftResumeDismissMain);
        if (result?.clicked) {
          logger?.info?.(
            `[Tistory] [DRAFT] dismissed resume popup (${result.via || 'dom'}) attempt=${attempt + 1} frame=${String(result.frameHref || '').slice(0, 80)}`,
          );
          return true;
        }
      } catch {
        /* cross-origin or detached frame */
      }
    }
  }

  logger?.info?.('[Tistory] [DRAFT] no resume popup dismissed (may be absent)');
  return false;
}

module.exports = {
  DRAFT_RESUME_DISMISS_GAPS_MS,
  DRAFT_RESUME_DISMISS_GAPS_QUICK_MS,
  DRAFT_RESUME_DIALOG_MESSAGE_RE,
  DRAFT_RESUME_POPUP_TEXT_RE,
  isDraftResumeDialogMessage,
  tistoryDraftResumeDismissMain,
  dismissTistoryDraftResumePopup,
};
