'use strict';

/**
 * @file tistory_editor_inject.js
 * @description 티스토리 에디터 HTML 주입 자동화 (핵심 모듈)
 * @purpose  Gemini가 생성한 HTML 본문을 티스토리 에디터에 삽입하고,
 *           이미지 플레이스홀더 처리, 태그 입력, 카테고리 설정까지 처리.
 * @exports  injectContentToTistoryEditor, setTistoryTags, setTistoryCategory
 * @seeAlso  tistory_placeholder_gate.js, tistory_placeholder_util.js, gemini_validate.js
 */


const fs = require('fs');
const path = require('path');
const minimist = require('minimist');
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
const {
  buildNewPostUrl,
  validateTistoryArgs,
  isOnTistoryNewPost,
  isSessionExpiredRedirect,
  isOnKakaoLogin,
  TISTORY_PAGE_LOAD_TIMEOUT_MS,
  TISTORY_ERROR,
  normalizeFailureReason,
} = require('./tistory_common');
const {
  harvestPublishedPost,
  logPublishedJsonLine,
  extractFirstH1PlainTextFromHtml,
  readTistoryEditorTitleFromPage,
} = require('./tistory_publish_harvest');
const { resetTistoryCoverThumbnailOnPage } = require('./tistory_cover_reset');
const {
  injectTistoryPlaceholderGate,
  triggerTistoryPublishLayerFlow,
} = require('./tistory_placeholder_gate');
const { countTistoryPlaceholdersInHtml } = require('./tistory_placeholder_util');
const { dismissTistoryDraftResumePopup } = require('./tistory_draft_resume');
const {
  isTistoryInjectDebugEnabled,
  dumpTistoryEditorSnapshot,
} = require('./_legacy/tistory_editor_inject_debug');

const ENGINE = 'Playwright';
const INJECT_WAIT_TIMEOUT_MS = 25000;
const INJECT_POLL_MS = 400;
const INJECT_DEBUG_LOG_INTERVAL_MS = 2000;
/** Same as legacy runTistoryEditorGeminiPrefill delayMs (bg-tistory-kakao-flow.js). */
const TISTORY_EDITOR_LEGACY_SETTLE_MS = 500;
const EDITOR_MODE_WAIT_MS = 20000;

/** Staggered inject timing (legacy base + extra settle between phases). */
const TISTORY_INJECT_TIMING = {
  htmlModeMenuWaitMs: 15000,
  htmlModeMenuSettleMs: 150,
  htmlModeSwitchTimeoutMs: 20000,
  htmlModeCmPollMs: 100,
  htmlModeCmInitialDelayMs: 250,
  htmlModeMinBodyCmHeightPx: 48,
  htmlModeDropdownPollMs: 150,
  afterHtmlModeMs: 400,
  afterClearMs: 150,
  bodyInsert1Ms: 90,
  bodyInsert2Ms: 280,
  afterBodySettleMs: 400,
  titleRetryMs: [500, 1500, 3000],
  beforeTagsMs: 1200,
  tagStepStartMs: 350,
  tagBetweenMs: 260,
  tagEnterMs: 80,
  tagMissMs: 200,
  publishBaseMs: 5600,
  publishPerTagMs: 320,
};

const TISTORY_INJECT_SLOW_MULTIPLIER = 1.25;

function resolveInjectTiming(options = {}) {
  const timing = { ...TISTORY_INJECT_TIMING };
  if (options.slowProfile) {
    for (const key of Object.keys(timing)) {
      if (key === 'titleRetryMs' && Array.isArray(timing.titleRetryMs)) {
        timing.titleRetryMs = timing.titleRetryMs.map((ms) =>
          Math.round(ms * TISTORY_INJECT_SLOW_MULTIPLIER),
        );
      } else if (key === 'htmlModeMinBodyCmHeightPx') {
        /* Keep CM height gate stable in debug slow profile (60px broke HTML CM detect). */
      } else if (typeof timing[key] === 'number') {
        timing[key] = Math.round(timing[key] * TISTORY_INJECT_SLOW_MULTIPLIER);
      }
    }
  }
  return timing;
}

/**
 * MAIN-world inject — port of jably_blog bg-tistory-kakao-flow.js tistoryEditorModeClickMain.
 * Playwright page.evaluate serializes this function; keep it self-contained.
 *
 * @param {string | { prefillHtml?: string, publishOpts?: object, debug?: boolean }} arg
 */
function tistoryEditorModeClickMain(arg) {
  let prefillHtml = '';
  let publishOpts = {};
  let debug = false;
  let timingArg = null;

  let strictHtmlMode = true;
  if (typeof arg === 'string') {
    prefillHtml = arg;
  } else if (arg && typeof arg === 'object') {
    prefillHtml = typeof arg.prefillHtml === 'string' ? arg.prefillHtml : '';
    publishOpts =
      arg.publishOpts && typeof arg.publishOpts === 'object' && !Array.isArray(arg.publishOpts)
        ? arg.publishOpts
        : {};
    debug = arg.debug === true;
    timingArg = arg.timing && typeof arg.timing === 'object' ? arg.timing : null;
    if (arg.strictHtmlMode === false) {
      strictHtmlMode = false;
    }
  }

  function resolveBrowserTiming() {
    const defaults = {
      htmlModeMenuWaitMs: 15000,
      htmlModeMenuSettleMs: 150,
      htmlModeSwitchTimeoutMs: 20000,
      htmlModeCmPollMs: 100,
      htmlModeCmInitialDelayMs: 250,
      htmlModeMinBodyCmHeightPx: 48,
      htmlModeDropdownPollMs: 150,
      afterHtmlModeMs: 400,
      afterClearMs: 150,
      bodyInsert1Ms: 90,
      bodyInsert2Ms: 280,
      afterBodySettleMs: 400,
      titleRetryMs: [500, 1500, 3000],
      beforeTagsMs: 1200,
      tagStepStartMs: 350,
      tagBetweenMs: 260,
      tagEnterMs: 80,
      tagMissMs: 200,
      publishBaseMs: 5600,
      publishPerTagMs: 320,
    };
    if (!timingArg) {
      return defaults;
    }
    const merged = { ...defaults };
    for (const key of Object.keys(defaults)) {
      if (timingArg[key] == null) continue;
      if (key === 'titleRetryMs' && Array.isArray(timingArg.titleRetryMs)) {
        merged.titleRetryMs = timingArg.titleRetryMs;
      } else if (typeof timingArg[key] === 'number') {
        merged[key] = timingArg[key];
      }
    }
    return merged;
  }

  const sleepLocal = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

  function injectLog(phase, detail) {
    const payload = { phase, at: Date.now(), detail: detail ?? null };
    try {
      if (!window.__jablyTistoryInjectDebug) {
        window.__jablyTistoryInjectDebug = { events: [] };
      }
      window.__jablyTistoryInjectDebug.events.push(payload);
      if (window.__jablyTistoryInjectDebug.events.length > 48) {
        window.__jablyTistoryInjectDebug.events.shift();
      }
    } catch {
      /* ignore */
    }
    if (debug) {
      console.log('[ja_test][TistoryInject]', phase, detail ?? '');
    }
  }

  try {
    window.alert = function alertStub() { };
    window.confirm = function confirmStub() {
      return true;
    };
    window.prompt = function promptStub() {
      return null;
    };
  } catch {
    /* ignore */
  }

  let htmlToApply = prefillHtml;

  function stripTitleAndTags(html) {
    let res = html;
    // Strip tags paragraph
    res = res.replace(/<p>[^<]*((권장|추천|해시|관련|참고)\s*태그|tags?)\s*[：:][\s\S]*?<\/p>/i, '');
    // Or if it's just a bunch of hashtags in the last paragraph
    res = res.replace(/<p>[\s]*((#[^\s#<]+[\s]*)+)<\/p>(?![\s\S]*<p>)/gi, '');
    
    // Convert <hr> tags into div borders to prevent Tistory from changing them into dotted lines (...)
    res = res.replace(/<hr\b[^>]*>/gi, '<div style="border-top: 1px solid #e5e7eb; margin: 40px 0;"></div>');
    
    // Title ripping is prevented by the <p><br></p> prepended in playwright_tistory_publish.js,
    // so we no longer need to strip the first H1-H3 here.
    return res;
  }

  htmlToApply = stripTitleAndTags(htmlToApply);
  const pub = publishOpts;
  const wantPublic = pub.isPublic === true;
  const autoPublish = pub.autoPublish === true;
  const deferAutoPublish = pub.deferAutoPublish === true;
  const categoryItemId =
    typeof pub.categoryItemId === 'string' ? pub.categoryItemId.trim() : '';
  let started = false;

  /** Prevent hammering HTML/layer buttons after mode switch (fallback loop bug). */
  const htmlModeSwitchState = {
    htmlMenuClicked: false,
    layerClickCount: 0,
    maxLayerClicks: 4,
    locked: false,
  };

  /** bg-tistory-kakao-flow.js findBodyCodeMirror — first non-title CM (no height gate). */
  function findBodyCodeMirrorLegacy() {
    for (const ta of document.querySelectorAll('textarea')) {
      if (isTitleTextarea(ta)) {
        continue;
      }
      const sib = ta.nextElementSibling;
      if (sib?.classList?.contains('CodeMirror') && sib.CodeMirror) {
        return sib.CodeMirror;
      }
    }
    for (const node of document.querySelectorAll('.CodeMirror')) {
      if (node.CodeMirror && typeof node.CodeMirror.setValue === 'function') {
        if (
          node.closest?.(
            '#post-title-inp, .textarea_tit, .post-title, .title_area, .wrap_title',
          )
        ) {
          continue;
        }
        return node.CodeMirror;
      }
    }
    return null;
  }

  function findBodyCodeMirrorForInject(timing) {
    const minH = htmlModeBodyCmMinHeightPx(timing);
    if (isHtmlModeSwitchUiSatisfied()) {
      return findBodyCodeMirrorLegacy() || findBodyCodeMirror(minH);
    }
    return findBodyCodeMirrorLegacy() || findBodyCodeMirror(minH);
  }

  /** Toolbar shows HTML (post-switch); `#editor-mode-layer-btn-open` may stay hidden with stale "기본모드". */
  function isHtmlToolbarModeActive() {
    const opener = findHtmlEditorModeOpener();
    if (!opener) {
      return false;
    }
    const st = getComputedStyle(opener);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) {
      return false;
    }
    const r = opener.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  }

  function readEditorModeLayerLabel() {
    if (isHtmlToolbarModeActive()) {
      return 'HTML';
    }
    const btn = document.querySelector('#editor-mode-layer-btn-open');
    const span =
      btn?.querySelector('.mce-txt') ||
      document.querySelector('#editor-mode-layer-btn .mce-txt');
    return String(span?.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isHtmlModeLayerLabel() {
    if (isHtmlToolbarModeActive()) {
      return true;
    }
    const label = readEditorModeLayerLabel();
    return /html/i.test(label) && !/기본\s*모드/i.test(label);
  }

  /** True when layer shows HTML or #editor-mode-html menu item is selected (not merely any CodeMirror). */
  function isHtmlModeMenuSelected(ui) {
    if (ui?.htmlModeSelected) {
      return true;
    }
    const htmlItem = document.querySelector('#editor-mode-html');
    if (!htmlItem) {
      return false;
    }
    return (
      htmlItem.classList.contains('mce-active') ||
      htmlItem.classList.contains('on') ||
      htmlItem.getAttribute('aria-checked') === 'true' ||
      htmlItem.getAttribute('aria-selected') === 'true'
    );
  }

  function isHtmlModeSwitchUiSatisfied(ui) {
    return (
      isHtmlModeLayerLabel() ||
      isHtmlToolbarModeActive() ||
      isHtmlModeMenuSelected(ui)
    );
  }

  function htmlModeBodyCmMinHeightPx(timing) {
    const configured = timing?.htmlModeMinBodyCmHeightPx ?? 48;
    if (isHtmlToolbarModeActive() || htmlModeSwitchState.htmlMenuClicked) {
      return Math.min(configured, 20);
    }
    return configured;
  }

  function isBodyHtmlEditorActive(timing) {
    return isHtmlModeSwitchUiSatisfied(probeHtmlModeUiState(timing));
  }

  function lockHtmlModeSwitch(reason) {
    htmlModeSwitchState.locked = true;
    injectLog('html_mode_switch_locked', reason);
  }

  function clickLayerOpenOnce(tag) {
    if (htmlModeSwitchState.locked) {
      return false;
    }
    if (htmlModeSwitchState.layerClickCount >= htmlModeSwitchState.maxLayerClicks) {
      injectLog('html_mode_layer_click_cap', {
        tag,
        count: htmlModeSwitchState.layerClickCount,
      });
      return false;
    }
    const openBtn = document.querySelector('#editor-mode-layer-btn-open');
    if (!openBtn) {
      return false;
    }
    htmlModeSwitchState.layerClickCount += 1;
    injectLog('html_mode_layer_open', { tag, count: htmlModeSwitchState.layerClickCount });
    openBtn.focus();
    openBtn.click();
    return true;
  }

  function waitForSelector(selector, timeoutMs, onDone) {
    const t0 = Date.now();
    function tick() {
      const el = document.querySelector(selector);
      if (el) {
        onDone(el);
        return;
      }
      if (Date.now() - t0 >= timeoutMs) {
        onDone(null);
        return;
      }
      window.setTimeout(tick, 100);
    }
    tick();
  }

  function isTitleTextarea(ta) {
    if (!ta) {
      return false;
    }
    if (ta.id === 'post-title-inp') {
      return true;
    }
    if (ta.classList?.contains('textarea_tit')) {
      return true;
    }
    if (ta.closest?.('.post-title, .title_area, .wrap_title')) {
      return true;
    }
    return false;
  }

  function getCodeMirrorWrapperElement(cm) {
    if (!cm) {
      return null;
    }
    try {
      if (typeof cm.getWrapperElement === 'function') {
        return cm.getWrapperElement();
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  function isCodeMirrorWrapperVisible(wrap) {
    if (!wrap) {
      return false;
    }
    const st = getComputedStyle(wrap);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) {
      return false;
    }
    const r = wrap.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  }

  function isLikelyBodyHtmlCodeMirror(cm, minHeightPx) {
    if (!cm || typeof cm.setValue !== 'function') {
      return false;
    }
    const input = typeof cm.getInputField === 'function' ? cm.getInputField() : null;
    if (input && isTitleTextarea(input)) {
      return false;
    }
    const wrap = getCodeMirrorWrapperElement(cm);
    if (!wrap) {
      return false;
    }
    if (wrap.closest?.('#post-title-inp, .textarea_tit, .post-title, .title_area, .wrap_title')) {
      return false;
    }
    if (!isCodeMirrorWrapperVisible(wrap)) {
      return false;
    }
    const r = wrap.getBoundingClientRect();
    const inEditorShell = !!wrap.closest(
      '#editor-contents, .editor_contents, .editor-content, .area_editor, .contents_editor, .mce-tinymce, .post-editor',
    );
    if (inEditorShell && r.height >= minHeightPx) {
      return true;
    }
    return r.height >= Math.max(minHeightPx, 80) && r.width >= 120;
  }

  function findBodyCodeMirrorCandidates(minHeightPx) {
    const seen = new Set();
    const candidates = [];

    function pushCandidate(cm) {
      if (!cm || seen.has(cm)) {
        return;
      }
      if (!isLikelyBodyHtmlCodeMirror(cm, minHeightPx)) {
        return;
      }
      seen.add(cm);
      candidates.push(cm);
    }

    for (const ta of document.querySelectorAll('textarea')) {
      if (isTitleTextarea(ta)) {
        continue;
      }
      const sib = ta.nextElementSibling;
      if (sib?.classList?.contains('CodeMirror') && sib.CodeMirror) {
        pushCandidate(sib.CodeMirror);
      }
    }

    for (const node of document.querySelectorAll('.CodeMirror')) {
      if (node.CodeMirror) {
        pushCandidate(node.CodeMirror);
      }
    }

    return candidates;
  }

  function findBodyCodeMirror(minHeightPx) {
    const minH =
      typeof minHeightPx === 'number' && minHeightPx > 0 ? minHeightPx : 48;
    const candidates = findBodyCodeMirrorCandidates(minH);
    if (!candidates.length) {
      return null;
    }
    if (candidates.length === 1) {
      return candidates[0];
    }

    let best = candidates[0];
    let bestArea = 0;
    for (const cm of candidates) {
      const wrap = getCodeMirrorWrapperElement(cm);
      if (!wrap) {
        continue;
      }
      const r = wrap.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) {
        bestArea = area;
        best = cm;
      }
    }
    return best;
  }

  function clearTistoryTitleAndTagChips() {
    const titleEl =
      document.querySelector('#post-title-inp') ||
      document.querySelector('textarea.textarea_tit');
    if (titleEl) {
      const old = titleEl.value;
      titleEl.focus();
      try {
        const desc = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype,
          'value',
        );
        if (desc && desc.set) {
          desc.set.call(titleEl, '');
        } else {
          titleEl.value = '';
        }
      } catch {
        titleEl.value = '';
      }
      const tracker = titleEl._valueTracker;
      if (tracker && typeof tracker.setValue === 'function') {
        tracker.setValue(old);
      }
      titleEl.dispatchEvent(new Event('input', { bubbles: true }));
      titleEl.dispatchEvent(new Event('change', { bubbles: true }));
    }

    let cap = 0;
    while (cap < 80) {
      cap += 1;
      const del = document.querySelector('.editor_tag .btn_delete');
      if (!del) break;
      try {
        del.click();
      } catch {
        break;
      }
    }

    const inputs = document.querySelectorAll(
      'input.tf_g[name="tagText"], input#tagText, input[name="tagText"]',
    );
    inputs.forEach((tagInp) => {
      if (!tagInp.value) return;
      const o = tagInp.value;
      tagInp.focus();
      try {
        const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
        if (d && d.set) {
          d.set.call(tagInp, '');
        } else {
          tagInp.value = '';
        }
      } catch {
        tagInp.value = '';
      }
      const tr = tagInp._valueTracker;
      if (tr && typeof tr.setValue === 'function') {
        tr.setValue(o);
      }
      tagInp.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  function extractFirstH1PlainText(html) {
    if (!html || typeof html !== 'string') return '';
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const h = doc.querySelector('h1, h2, h3');
      if (h) return (h.textContent || '').replace(/\s+/g, ' ').trim();
      const p = doc.querySelector('p');
      if (p) {
        let text = (p.textContent || '').replace(/\s+/g, ' ').trim();
        if (text.length > 50) text = text.substring(0, 50) + '...';
        return text;
      }
      return '';
    } catch {
      return '';
    }
  }

  function extractRecommendedTagHashtags(html) {
    if (!html || typeof html !== 'string') return [];

    // 1) Try to find explicit tag section label
    let idx = html.search(/((권장|추천|해시|관련|참고)\s*태그|tag(s)?)\s*[：:]/i);

    // 2) Fallback: find any block that has 3+ hashtags in it
    if (idx === -1) {
      const matches = html.match(/<[^>]+>[\s]*((#[^\s#<]+[\s]*){3,})<\/[^>]+>/gi);
      if (matches && matches.length > 0) {
        idx = html.lastIndexOf(matches[matches.length - 1]);
      }
    }

    // 3) Fallback: look for paragraphs of just hashtags (2+)
    if (idx === -1) {
      const matches = html.match(/<p[^>]*>[\s]*((#[^\s#<]+[\s]*)+)<\/p>/gi);
      if (matches && matches.length > 0) {
        idx = html.lastIndexOf(matches[matches.length - 1]);
      }
    }

    if (idx === -1) {
      // 4) Last resort: scan last 3000 chars of the entire HTML for any hashtags
      const tail = html.slice(Math.max(0, html.length - 3000));
      const tailText = tail.replace(/<[^>]+>/g, ' ');
      const re = /#[^\s#]+/g;
      const tags = [];
      let m;
      while ((m = re.exec(tailText)) !== null) {
        const t = m[0].trim();
        if (t.length > 1) tags.push(t);
      }
      return [...new Set(tags)];
    }

    // Found a tag section — extract from it, allowing up to 5000 chars (multi-paragraph)
    const slice = html.slice(idx, Math.min(idx + 5000, html.length));
    const textOnly = slice.replace(/<[^>]+>/g, ' ');
    const tags = [];
    const re = /#[^\s#]+/g;
    let m;
    while ((m = re.exec(textOnly)) !== null) {
      const t = m[0].trim();
      if (t.length > 1) tags.push(t);
    }
    return [...new Set(tags)];
  }

  function fillTistoryPostTitleValue(title) {
    if (!title) return;
    const el =
      document.querySelector('#post-title-inp') ||
      document.querySelector('textarea.textarea_tit');
    if (!el) return;
    const old = el.value;
    el.focus();
    try {
      const desc = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      );
      if (desc && desc.set) {
        desc.set.call(el, title);
      } else {
        el.value = title;
      }
    } catch {
      el.value = title;
    }
    const tracker = el._valueTracker;
    if (tracker && typeof tracker.setValue === 'function') {
      tracker.setValue(old);
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    try {
      el.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          inputType: 'insertFromPaste',
          data: title,
        }),
      );
    } catch {
      /* ignore */
    }
  }

  function fillTistoryPostTitleFromH1(html) {
    fillTistoryPostTitleValue(extractFirstH1PlainText(html));
  }

  function getTistoryTagTextInput() {
    const all = document.querySelectorAll(
      'input.tf_g[name="tagText"], input#tagText, input[name="tagText"]',
    );
    return all.length ? all[all.length - 1] : document.querySelector('#tagText');
  }

  function stripLeadingHashtagsForTistoryTagInput(raw) {
    if (raw == null) return '';
    const s = String(raw).trim();
    return s.replace(/^#+/, '').trim();
  }

  function setTistoryTagInputValue(inp, val) {
    const normalized = stripLeadingHashtagsForTistoryTagInput(val);
    if (!normalized) return false;
    const old = inp.value;
    inp.focus();
    try {
      const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      if (desc && desc.set) {
        desc.set.call(inp, normalized);
      } else {
        inp.value = normalized;
      }
    } catch {
      inp.value = normalized;
    }
    const tracker = inp._valueTracker;
    if (tracker && typeof tracker.setValue === 'function') {
      tracker.setValue(old);
    }
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    try {
      inp.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          inputType: 'insertFromPaste',
          data: normalized,
        }),
      );
    } catch {
      /* ignore */
    }
    return true;
  }

  function dispatchEnterOnTagInput(inp) {
    try {
      const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      inp.dispatchEvent(new KeyboardEvent('keydown', opts));
      inp.dispatchEvent(new KeyboardEvent('keypress', opts));
      inp.dispatchEvent(new KeyboardEvent('keyup', opts));
    } catch {
      /* ignore */
    }
  }

  function fillTistoryTagsList(tags, T) {
    if (!tags.length) {
      injectLog('phase_tags_skip', 'no_tags');
      return;
    }
    let i = 0;
    let miss = 0;
    const delayBetween = T.tagBetweenMs;
    function step() {
      if (i >= tags.length) {
        injectLog('phase_tags_done', { count: tags.length });
        return;
      }
      const inp = getTistoryTagTextInput();
      if (!inp) {
        miss += 1;
        if (miss < 50) window.setTimeout(step, T.tagMissMs);
        return;
      }
      miss = 0;
      const tag = tags[i];
      const applied = setTistoryTagInputValue(inp, tag);
      if (!applied) {
        i += 1;
        window.setTimeout(step, delayBetween);
        return;
      }
      window.setTimeout(() => {
        dispatchEnterOnTagInput(inp);
        i += 1;
        window.setTimeout(step, delayBetween);
      }, T.tagEnterMs);
    }
    window.setTimeout(step, T.tagStepStartMs);
  }

  function fillTistoryTagsFromRecommendedLine(html, T) {
    fillTistoryTagsList(extractRecommendedTagHashtags(html), T);
  }

  function applyBodyToCodeMirrorStaged(cm, html, T) {
    return new Promise((resolve) => {
      if (!html || !html.length) {
        try {
          cm.setValue('');
        } catch {
          /* ignore */
        }
        resolve();
        return;
      }

      const CM = window.CodeMirror;
      const pos =
        CM && typeof CM.Pos === 'function'
          ? (line, ch) => CM.Pos(line, ch)
          : (line, ch) => ({ line, ch });
      const input = typeof cm.getInputField === 'function' ? cm.getInputField() : null;

      function injectSpaceLikeUser() {
        try {
          cm.setValue('');
        } catch {
          /* ignore */
        }
        cm.focus();
        if (input) {
          try {
            input.focus();
            input.dispatchEvent(
              new KeyboardEvent('keydown', {
                key: ' ',
                code: 'Space',
                keyCode: 32,
                which: 32,
                bubbles: true,
                cancelable: true,
              }),
            );
            input.dispatchEvent(
              new InputEvent('beforeinput', {
                bubbles: true,
                cancelable: true,
                inputType: 'insertText',
                data: ' ',
                isComposing: false,
              }),
            );
          } catch {
            /* ignore */
          }
        }
        try {
          cm.replaceRange(' ', pos(0, 0), pos(0, 0));
        } catch {
          try {
            cm.setValue(' ');
          } catch {
            /* ignore */
          }
        }
        if (input) {
          try {
            input.dispatchEvent(
              new InputEvent('input', {
                bubbles: true,
                inputType: 'insertText',
                data: ' ',
                isComposing: false,
              }),
            );
            input.dispatchEvent(
              new KeyboardEvent('keyup', {
                key: ' ',
                code: 'Space',
                keyCode: 32,
                which: 32,
                bubbles: true,
                cancelable: true,
              }),
            );
          } catch {
            /* ignore */
          }
        }
      }

      let bodyInserted = false;
      function insertBodyOnce() {
        if (bodyInserted) return;
        cm.focus();
        let ch = 1;
        try {
          const line0 = cm.getLine(0);
          if (typeof line0 !== 'string' || line0.length < 1) ch = 0;
          cm.replaceRange(html, pos(0, ch), pos(0, ch));
          bodyInserted = true;
        } catch {
          try {
            cm.setValue(ch === 0 ? html : `\u0020${html}`);
            bodyInserted = true;
          } catch {
            /* ignore */
          }
        }
        try {
          cm.refresh();
        } catch {
          /* ignore */
        }
      }

      injectSpaceLikeUser();
      window.setTimeout(insertBodyOnce, T.bodyInsert1Ms);
      window.setTimeout(insertBodyOnce, T.bodyInsert2Ms);
      const bodyDoneMs = Math.max(T.bodyInsert1Ms, T.bodyInsert2Ms) + T.afterBodySettleMs;
      window.setTimeout(() => resolve(), bodyDoneMs);
    });
  }

  /** Preserve legacy publish deadline from apply start (bg-tistory-kakao-flow.js). */
  function scheduleLayerPublishAndSave(isPublic, applyT0, T) {
    if (!autoPublish) return;
    if (deferAutoPublish) {
      console.log('[ja_test][Tistory] publish skipped (deferAutoPublish)');
      return;
    }
    const tagsN = extractRecommendedTagHashtags(prefillHtml).length;
    const deadline = T.publishBaseMs + tagsN * T.publishPerTagMs;
    const elapsed = Date.now() - applyT0;
    const waitMs = Math.max(800, deadline - elapsed);
    injectLog('schedule_publish', { waitMs, elapsed, tagsN, deadline });
    window.setTimeout(() => {
      const gate = window.__jablyTistoryPlaceholderGate;
      if (typeof gate?.publishLayerFlow === 'function') {
        gate.publishLayerFlow(isPublic, categoryItemId, { layerOpenDelayMs: 0 });
        return;
      }
      console.warn('[ja_test][Tistory] publish skipped — placeholder gate missing');
    }, waitMs);
  }

  function dispatchClickChain(el) {
    if (!el) return;
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    } catch {
      /* ignore */
    }
    try {
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    } catch {
      /* ignore */
    }
    try {
      el.focus();
      el.click();
    } catch {
      /* ignore */
    }
  }

  /** TinyMCE toolbar: `div.mce-widget` with label HTML (bg-tistory-kakao-flow.js). */
  function findHtmlEditorModeOpener() {
    for (const w of document.querySelectorAll("div.mce-widget.mce-btn[role='button']")) {
      const t = w.querySelector('i.mce-txt');
      if (t && (t.textContent || '').trim() === 'HTML') {
        return w;
      }
    }
    for (const b of document.querySelectorAll('button')) {
      const i = b.querySelector('i.mce-txt');
      if (i && (i.textContent || '').trim() === 'HTML') {
        return b;
      }
    }
    return null;
  }

  function isMenuItemLikelyVisible(el) {
    if (!el) return false;
    const menu = el.closest('.mce-menu') || el.closest('.mce-floatpanel');
    if (menu) {
      const st = getComputedStyle(menu);
      if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) {
        return false;
      }
    }
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  }

  /**
   * Open mode menu: `.mce-menu.mce-in` with #editor-mode-kakao | markdown | html (Tistory newpost).
   * @returns {HTMLElement|null}
   */
  function findOpenTistoryModeMenu() {
    const selectors = [
      '.mce-menu.mce-floatpanel.mce-in',
      '.mce-floatpanel.mce-menu.mce-in',
      '.mce-menu.mce-in',
    ];
    for (const sel of selectors) {
      for (const menu of document.querySelectorAll(sel)) {
        if (
          !menu.querySelector(
            '#editor-mode-html, #editor-mode-kakao, #editor-mode-markdown',
          )
        ) {
          continue;
        }
        const st = getComputedStyle(menu);
        if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) {
          continue;
        }
        const r = menu.getBoundingClientRect();
        if (r.width > 8 && r.height > 8) {
          return menu;
        }
      }
    }
    const htmlItem = document.querySelector('#editor-mode-html.mce-tistory-mode-item, #editor-mode-html');
    const menu = htmlItem?.closest('.mce-menu, .mce-floatpanel');
    if (!menu) {
      return null;
    }
    const st = getComputedStyle(menu);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) {
      return null;
    }
    const r = menu.getBoundingClientRect();
    return r.width > 8 && r.height > 8 ? menu : null;
  }

  function resolveHtmlModeMenuItem() {
    const menu = findOpenTistoryModeMenu();
    if (menu) {
      return (
        menu.querySelector('#editor-mode-html.mce-tistory-mode-item') ||
        menu.querySelector('#editor-mode-html')
      );
    }
    return (
      document.querySelector('#editor-mode-html.mce-tistory-mode-item') ||
      document.querySelector('#editor-mode-html')
    );
  }

  /** #editor-mode-html inside open `.mce-menu.mce-in` float panel (not detached hidden node). */
  function isModeDropdownMenuOpen() {
    const menu = findOpenTistoryModeMenu();
    if (!menu) {
      return false;
    }
    const htmlItem = menu.querySelector('#editor-mode-html');
    return !!htmlItem && isMenuItemLikelyVisible(htmlItem);
  }

  function isHtmlModeMenuItemInOpenMenu(htmlItem) {
    const item = htmlItem || resolveHtmlModeMenuItem();
    if (!item || !isMenuItemLikelyVisible(item)) {
      return false;
    }
    const menu = findOpenTistoryModeMenu();
    return !!menu && menu.contains(item);
  }

  function waitForSelectorPromise(selector, timeoutMs) {
    return new Promise((resolve) => {
      waitForSelector(selector, timeoutMs, resolve);
    });
  }

  /** After #editor-mode-layer-btn-open: float menu open + #editor-mode-html visible (기본모드 dropdown). */
  async function waitForVisibleHtmlModeMenuItem(timing, timeoutMs) {
    if (isHtmlModeLayerLabel()) {
      injectLog('html_mode_menu_wait_skip', {
        layerLabel: readEditorModeLayerLabel(),
        reason: 'layer_already_html',
      });
      return document.querySelector('#editor-mode-html');
    }

    await sleepLocal(timing.htmlModeMenuSettleMs);

    const t0 = Date.now();
    let polls = 0;
    while (Date.now() - t0 < timeoutMs) {
      if (isHtmlModeLayerLabel()) {
        injectLog('html_mode_menu_visible_skip', {
          polls,
          layerLabel: readEditorModeLayerLabel(),
          reason: 'layer_became_html',
        });
        return document.querySelector('#editor-mode-html');
      }

      const htmlItem = resolveHtmlModeMenuItem();
      if (htmlItem && isHtmlModeMenuItemInOpenMenu(htmlItem)) {
        injectLog('html_mode_menu_visible', {
          polls,
          elapsedMs: Date.now() - t0,
          layerLabel: readEditorModeLayerLabel(),
          menuId: findOpenTistoryModeMenu()?.id || '',
        });
        return htmlItem;
      }

      polls += 1;
      if (polls > 0 && polls % 10 === 0) {
        clickLayerOpenOnce('menu_wait_reopen');
        await sleepLocal(timing.htmlModeMenuSettleMs);
      }
      await sleepLocal(100);
    }
    injectLog('html_mode_menu_visible_timeout', {
      waitedMs: timeoutMs,
      polls,
      layerLabel: readEditorModeLayerLabel(),
      menuOpen: isModeDropdownMenuOpen(),
    });
    return null;
  }

  function validateHtmlModeUiForContinue(ui, strict) {
    if (isHtmlModeLayerLabel() || ui?.isHtmlModeLayerLabel || isHtmlToolbarModeActive()) {
      return { ok: true, via: 'layer_label_html' };
    }
    if (isHtmlModeMenuSelected(ui)) {
      return { ok: true, via: 'menu_item_selected' };
    }
    if (htmlModeSwitchState.htmlMenuClicked && findBodyCodeMirrorLegacy()) {
      return { ok: true, via: 'body_codemirror_after_html_click' };
    }
    if (!strict) {
      return { ok: true, relaxed: true };
    }
    return {
      ok: false,
      reason: 'html_mode_not_active',
      ui,
      layerLabel: readEditorModeLayerLabel(),
    };
  }

  /** Legacy inject path: click `#editor-mode-html` menuitem in open `.mce-menu.mce-in`. */
  function clickHtmlModeMenuItemLegacy(htmlItem, timing) {
    const target =
      htmlItem ||
      resolveHtmlModeMenuItem() ||
      document.querySelector('#editor-mode-html.mce-tistory-mode-item, #editor-mode-html');
    if (!target) {
      return false;
    }
    if (
      htmlModeSwitchState.locked ||
      htmlModeSwitchState.htmlMenuClicked ||
      isHtmlModeLayerLabel() ||
      isHtmlModeMenuSelected()
    ) {
      injectLog('html_mode_html_click_skipped', {
        locked: htmlModeSwitchState.locked,
        clicked: htmlModeSwitchState.htmlMenuClicked,
        layerHtml: isHtmlModeLayerLabel(),
        menuSelected: isHtmlModeMenuSelected(),
      });
      return false;
    }
    htmlModeSwitchState.htmlMenuClicked = true;
    const label =
      target.querySelector('#editor-mode-html-text, span.mce-text')?.textContent?.trim() || 'HTML';
    injectLog('html_mode_html_click_legacy', {
      id: target.id,
      label,
      menuId: findOpenTistoryModeMenu()?.id || '',
    });
    try {
      target.scrollIntoView?.({ block: 'center', behavior: 'auto' });
      target.focus();
      target.click();
      const textSpan = target.querySelector('#editor-mode-html-text, span.mce-text');
      if (textSpan) {
        textSpan.click();
      }
    } catch (error) {
      injectLog('html_mode_html_click_err', String(error));
      return false;
    }
    return true;
  }

  function probeHtmlModeUiState(timing) {
    const minH = timing?.htmlModeMinBodyCmHeightPx ?? 48;
    const htmlItem = document.querySelector('#editor-mode-html');
    let htmlModeSelected = false;
    if (htmlItem) {
      htmlModeSelected =
        htmlItem.classList.contains('mce-active') ||
        htmlItem.classList.contains('on') ||
        htmlItem.getAttribute('aria-checked') === 'true' ||
        htmlItem.getAttribute('aria-selected') === 'true';
    }
    const layerLabel = readEditorModeLayerLabel();
    const openMenu = findOpenTistoryModeMenu();
    const htmlToolbar = isHtmlToolbarModeActive();
    return {
      modeOpenBtn: !!document.querySelector('#editor-mode-layer-btn-open'),
      layerModeLabel: layerLabel,
      isHtmlToolbarModeActive: htmlToolbar,
      isHtmlModeLayerLabel: isHtmlModeLayerLabel(),
      modeMenuId: openMenu?.id || '',
      modeMenuOpen: !!openMenu,
      htmlModeItem: !!htmlItem,
      htmlMenuOpen: isModeDropdownMenuOpen(),
      htmlMenuVisible: htmlItem ? isMenuItemLikelyVisible(htmlItem) : false,
      htmlModeSelected,
      hasBodyCodeMirror: !!findBodyCodeMirrorForInject(timing),
      hasBodyCodeMirrorLegacy: !!findBodyCodeMirrorLegacy(),
      bodyCodeMirrorCount: findBodyCodeMirrorCandidates(minH).length,
    };
  }

  /** Legacy waitForCodeMirrorAndApply — poll legacy CM first, then strict heuristics. */
  async function waitForBodyCodeMirrorAfterHtml(timing, timeoutMs, pollMs) {
    const t0 = Date.now();
    const minH = htmlModeBodyCmMinHeightPx(timing);
    await sleepLocal(timing.htmlModeCmInitialDelayMs);
    while (Date.now() - t0 < timeoutMs) {
      const cm = findBodyCodeMirrorLegacy() || findBodyCodeMirror(minH);
      if (cm) {
        injectLog('html_mode_body_cm_found', {
          layerLabel: readEditorModeLayerLabel(),
          htmlToolbar: isHtmlToolbarModeActive(),
          minH,
          elapsedMs: Date.now() - t0,
        });
        return cm;
      }
      await sleepLocal(pollMs);
    }
    return null;
  }

  /**
   * Legacy bg-tistory-kakao-flow.js runFlow:
   * layer open → #editor-mode-html click → waitForCodeMirrorAndApply (no selected-flag gate).
   */
  async function tryLegacyHtmlModeSequence(timing) {
    const openBtn = document.querySelector('#editor-mode-layer-btn-open');
    if (!openBtn) {
      return { ok: false, reason: 'no_layer_btn' };
    }

    const preUi = probeHtmlModeUiState(timing);
    if (isHtmlModeSwitchUiSatisfied(preUi)) {
      const earlyCheck = validateHtmlModeUiForContinue(preUi, strictHtmlMode);
      const cm =
        findBodyCodeMirrorForInject(timing) ||
        (await waitForBodyCodeMirrorAfterHtml(
          timing,
          Math.min(timing.htmlModeSwitchTimeoutMs, 8000),
          timing.htmlModeCmPollMs,
        ));
      if (earlyCheck.ok && cm) {
        lockHtmlModeSwitch('already_html_mode');
        injectLog('html_mode_ready', { via: 'already_html_mode', ui: preUi, strictHtmlMode });
        return { ok: true, via: 'already_html_mode', ui: preUi, cm };
      }
    }

    if (!clickLayerOpenOnce('legacy_start')) {
      return { ok: false, reason: 'layer_click_cap' };
    }

    const htmlItem = await waitForVisibleHtmlModeMenuItem(
      timing,
      timing.htmlModeMenuWaitMs,
    );
    if (!htmlItem) {
      return {
        ok: false,
        reason: 'html_menu_not_visible',
        ui: probeHtmlModeUiState(timing),
      };
    }

    const menuItem = resolveHtmlModeMenuItem() || htmlItem;
    if (!isHtmlModeLayerLabel() && !isHtmlModeMenuSelected()) {
      clickHtmlModeMenuItemLegacy(menuItem, timing);
    } else {
      lockHtmlModeSwitch('html_mode_skip_redundant_menu_click');
    }

    const cm = await waitForBodyCodeMirrorAfterHtml(
      timing,
      timing.htmlModeSwitchTimeoutMs,
      timing.htmlModeCmPollMs,
    );
    if (!cm) {
      const ui = probeHtmlModeUiState(timing);
      injectLog('html_mode_body_cm_timeout', ui);
      return { ok: false, reason: 'body_codemirror_timeout', ui };
    }

    await sleepLocal(timing.afterHtmlModeMs);
    const ui = probeHtmlModeUiState(timing);
    const finalCheck = validateHtmlModeUiForContinue(ui, strictHtmlMode);
    if (!finalCheck.ok) {
      injectLog('html_mode_ready_rejected', { ui, finalCheck, strictHtmlMode });
      return { ok: false, reason: finalCheck.reason, ui };
    }

    lockHtmlModeSwitch('legacy_layer_html');
    injectLog('html_mode_ready', { via: 'legacy_layer_html', ui, strictHtmlMode });
    return { ok: true, via: 'legacy_layer_html', ui, cm };
  }

  /** Fallback when legacy sequence fails — no repeat HTML menu clicks after body CM is active. */
  async function tryFallbackHtmlModeSequence(timing) {
    const preUi = probeHtmlModeUiState(timing);
    if (htmlModeSwitchState.locked || isHtmlModeSwitchUiSatisfied(preUi)) {
      const uiCheck = validateHtmlModeUiForContinue(preUi, strictHtmlMode);
      const cm = findBodyCodeMirrorForInject(timing);
      if (uiCheck.ok && cm) {
        lockHtmlModeSwitch('fallback_skip_already_active');
        injectLog('html_mode_ready', { via: 'fallback_skip_active', ui: preUi, strictHtmlMode });
        return { ok: true, via: 'fallback_skip_active', ui: preUi, cm };
      }
    }

    injectLog('html_mode_fallback_start');
    const deadline = Date.now() + timing.htmlModeSwitchTimeoutMs;
    let dropdownOpens = 0;
    const minH = timing.htmlModeMinBodyCmHeightPx;

    while (Date.now() < deadline) {
      const ui = probeHtmlModeUiState(timing);
      if (isHtmlModeSwitchUiSatisfied(ui)) {
        const cm = findBodyCodeMirrorForInject(timing) || findBodyCodeMirror(minH);
        if (cm) {
          const uiCheck = validateHtmlModeUiForContinue(ui, strictHtmlMode);
          if (uiCheck.ok) {
            lockHtmlModeSwitch('fallback_body_cm');
            await sleepLocal(timing.afterHtmlModeMs);
            injectLog('html_mode_ready', { via: 'fallback_body_cm', dropdownOpens, ui, strictHtmlMode });
            return { ok: true, via: 'fallback_body_cm', dropdownOpens, ui, cm };
          }
          injectLog('html_mode_fallback_abort', { ui, reason: uiCheck.reason });
          return { ok: false, reason: uiCheck.reason || 'html_mode_not_ready', ui };
        }
      }

      if (!htmlModeSwitchState.htmlMenuClicked && !isHtmlModeLayerLabel()) {
        let htmlItem = resolveHtmlModeMenuItem();
        if (!htmlItem) {
          const remaining = deadline - Date.now();
          if (remaining > 0) {
            await sleepLocal(timing.htmlModeMenuSettleMs);
            htmlItem = resolveHtmlModeMenuItem();
          }
        }

        if (htmlItem && isHtmlModeMenuItemInOpenMenu(htmlItem)) {
          clickHtmlModeMenuItemLegacy(htmlItem, timing);
        } else if (!htmlModeSwitchState.locked && dropdownOpens < htmlModeSwitchState.maxLayerClicks) {
          const opener =
            findHtmlEditorModeOpener() || document.querySelector('#editor-mode-layer-btn-open');
          if (opener) {
            dropdownOpens += 1;
            injectLog('html_mode_fallback_open_dropdown', { attempt: dropdownOpens });
            opener.scrollIntoView?.({ block: 'center', behavior: 'auto' });
            const innerBtn =
              opener.tagName === 'BUTTON'
                ? opener
                : opener.querySelector("button[type='button']");
            dispatchClickChain(innerBtn || opener);
            htmlModeSwitchState.layerClickCount += 1;
          }
        }
      }

      await sleepLocal(timing.htmlModeDropdownPollMs);
    }

    injectLog('html_mode_timeout', { dropdownOpens });
    return { ok: false, reason: 'html_mode_timeout', dropdownOpens };
  }

  /** Switch to HTML/CodeMirror mode before clear/body (legacy sequence first). */
  async function switchToHtmlEditorMode(timing) {
    injectLog('html_mode_switch_start', {
      ...probeHtmlModeUiState(timing),
      strictHtmlMode,
    });
    const legacyResult = await tryLegacyHtmlModeSequence(timing);
    if (legacyResult.ok) {
      return legacyResult;
    }

    const recoverUi = legacyResult.ui || probeHtmlModeUiState(timing);
    const recoverCheck = validateHtmlModeUiForContinue(recoverUi, strictHtmlMode);
    const recoverCm = findBodyCodeMirrorForInject(timing);
    if (isHtmlModeSwitchUiSatisfied(recoverUi) && recoverCheck.ok && recoverCm) {
      lockHtmlModeSwitch('legacy_recover_html_ui');
      injectLog('html_mode_legacy_recover', { reason: legacyResult.reason, ui: recoverUi });
      return { ok: true, via: 'legacy_recover_html_ui', ui: recoverUi, cm: recoverCm };
    }

    injectLog('html_mode_legacy_failed', legacyResult.reason || 'unknown');
    return tryFallbackHtmlModeSequence(timing);
  }

  async function runStagedEditorFill() {
    const T = resolveBrowserTiming();
    const applyT0 = Date.now();
    injectLog('staged_fill_start', { htmlChars: htmlToApply.length, timing: T });

    const modeResult = await switchToHtmlEditorMode(T);
    if (!modeResult.ok) {
      injectLog('staged_fill_abort', modeResult.reason || 'html_mode_failed');
      return;
    }

    const cm = findBodyCodeMirrorForInject(T);
    if (!cm) {
      injectLog('staged_fill_abort', 'no_body_codemirror_after_html_mode');
      return;
    }

    const postModeUi = probeHtmlModeUiState(T);
    const postModeCheck = validateHtmlModeUiForContinue(postModeUi, strictHtmlMode);
    if (!postModeCheck.ok) {
      injectLog('staged_fill_abort', postModeCheck.reason || 'html_mode_not_active');
      return;
    }

    injectLog('phase_clear');
    clearTistoryTitleAndTagChips();
    await sleepLocal(T.afterClearMs);

    injectLog('phase_body_start');
    await applyBodyToCodeMirrorStaged(cm, htmlToApply, T);
    injectLog('phase_body_done', { elapsedMs: Date.now() - applyT0 });

    injectLog('phase_title_start');
    const forcedTitle = typeof pub.forcePostTitle === 'string' ? pub.forcePostTitle.trim() : '';
    if (forcedTitle) {
      fillTistoryPostTitleValue(forcedTitle);
      for (const ms of T.titleRetryMs) {
        window.setTimeout(() => fillTistoryPostTitleValue(forcedTitle), ms);
      }
    } else {
      fillTistoryPostTitleFromH1(prefillHtml);
      for (const ms of T.titleRetryMs) {
        window.setTimeout(() => fillTistoryPostTitleFromH1(prefillHtml), ms);
      }
    }
    await sleepLocal(T.beforeTagsMs);

    injectLog('phase_tags_start');
    const forcedTags = Array.isArray(pub.forceTags)
      ? pub.forceTags.map((tag) => String(tag || '').trim()).filter(Boolean)
      : [];
    if (forcedTags.length) {
      fillTistoryTagsList(forcedTags, T);
    } else {
      fillTistoryTagsFromRecommendedLine(prefillHtml, T);
    }
    scheduleLayerPublishAndSave(wantPublic, applyT0, T);
    injectLog('staged_fill_scheduled', { elapsedMs: Date.now() - applyT0 });
  }

  function runFlow() {
    if (started) return true;
    const openBtn = document.querySelector('#editor-mode-layer-btn-open');
    if (!openBtn) {
      return false;
    }
    started = true;
    injectLog('runFlow', 'staged_pipeline_start');
    void runStagedEditorFill().catch((error) => {
      injectLog('staged_fill_error', String(error));
    });
    return true;
  }

  injectLog('start', {
    htmlChars: htmlToApply.length,
    autoPublish,
    deferAutoPublish,
    isPublic: wantPublic,
  });

  if (runFlow()) return;

  const obs = new MutationObserver(() => {
    if (runFlow()) obs.disconnect();
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });

  let ticks = 0;
  const iv = window.setInterval(() => {
    ticks += 1;
    if (runFlow() || ticks >= 120) {
      window.clearInterval(iv);
      obs.disconnect();
    }
  }, 150);
}

function normalizePublishOpts(publishOpts = {}) {
  return {
    isPublic: publishOpts.isPublic === true,
    autoPublish: publishOpts.autoPublish === true,
    deferAutoPublish: publishOpts.deferAutoPublish === true,
    forcePostTitle: typeof publishOpts.forcePostTitle === 'string' ? publishOpts.forcePostTitle : undefined,
    forceTags: Array.isArray(publishOpts.forceTags) ? publishOpts.forceTags : undefined,
  };
}

/**
 * bg-tistory-kakao-flow.js runTistoryEditorGeminiPrefill defer rule:
 * autoPublish + placeholders → deferAutoPublish=true.
 */
function resolvePublishOptsFromHtml(html, publishOpts = {}) {
  const opts = normalizePublishOpts(publishOpts);
  const placeholderCount = countTistoryPlaceholdersInHtml(String(html ?? ''));
  let deferAutoPublish = opts.deferAutoPublish;
  if (publishOpts.ignorePlaceholderDefer === true) {
    deferAutoPublish = opts.deferAutoPublish;
  } else if (opts.autoPublish && placeholderCount > 0) {
    deferAutoPublish = true;
  }
  return {
    ...opts,
    deferAutoPublish,
    placeholderCount,
  };
}

function logInjectJsonLine(logger, payload) {
  const body = {
    ok: payload?.ok === true,
    chars: payload?.chars ?? 0,
    head: payload?.head ?? '',
    reason: payload?.reason ?? '',
  };
  logger.info(`[Tistory] [INJECT] ${JSON.stringify(body)}`);
}

function fail(logger, reason, detail, password) {
  const code = normalizeFailureReason(reason);
  const suffix = detail ? ` — ${detail}` : '';
  logger.result(RESULT.FAILED, `${code}${suffix}`);
  return EXIT.FAILED;
}

function readHtmlFromFile(htmlFile) {
  const target = path.resolve(htmlFile);
  if (!fs.existsSync(target)) {
    return { ok: false, reason: 'html_file_not_found', path: target };
  }
  const html = fs.readFileSync(target, 'utf8');
  if (!html.trim()) {
    return { ok: false, reason: 'empty_html_file', path: target };
  }
  return { ok: true, html, path: target };
}

function parseInjectCliArgs() {
  const args = minimist(process.argv.slice(2), {
    string: [
      'blog-url',
      'blogUrl',
      'newpost-url',
      'newpostUrl',
      'html-file',
      'htmlFile',
      'profile-dir',
      'profileDir',
    ],
    boolean: ['auto-publish', 'autoPublish', 'is-public', 'isPublic', 'defer-auto-publish', 'deferAutoPublish'],
    default: {
      'auto-publish': false,
      'is-public': false,
      'defer-auto-publish': true,
    },
  });

  const profileDirRaw = String(
    args['profile-dir'] || args.profileDir || 'profiles/playwright-tistory-profile',
  ).trim();

  const htmlFileRaw = String(args['html-file'] || args.htmlFile || '').trim();
  const blogUrl = String(args['blog-url'] || args.blogUrl || '').trim();
  const newpostUrlRaw = String(args['newpost-url'] || args.newpostUrl || '').trim();

  const autoPublish = args['auto-publish'] === true || args.autoPublish === true;
  const isPublic = args['is-public'] === true || args.isPublic === true;
  const deferExplicit =
    args['defer-auto-publish'] === true || args.deferAutoPublish === true;
  const deferAutoPublish = deferExplicit ? true : !autoPublish;

  return {
    blogUrl,
    newPostUrl: newpostUrlRaw || (blogUrl ? buildNewPostUrl(blogUrl) : ''),
    htmlFile: htmlFileRaw ? path.resolve(process.cwd(), htmlFileRaw) : '',
    profileDir: path.resolve(process.cwd(), profileDirRaw),
    publishOpts: {
      isPublic,
      autoPublish,
      deferAutoPublish,
    },
  };
}

function logInjectPhase(logger, phase, detail) {
  const suffix =
    detail == null
      ? ''
      : typeof detail === 'string'
        ? ` — ${detail}`
        : ` — ${JSON.stringify(detail)}`;
  logger?.info?.(`[TistoryInject] ${phase}${suffix}`);
}

/**
 * Legacy parity: wait for editor chrome + settle before MAIN-world inject.
 * @param {import('playwright').Page} page
 */
async function waitForTistoryEditorReady(page, logger, timeoutMs = EDITOR_MODE_WAIT_MS) {
  const t0 = Date.now();
  logInjectPhase(logger, 'wait_editor_ui', { timeoutMs });

  try {
    await page.locator('#editor-mode-layer-btn-open').first().waitFor({
      state: 'visible',
      timeout: timeoutMs,
    });
    logInjectPhase(logger, 'mode_button_visible', { elapsedMs: Date.now() - t0 });
  } catch (error) {
    const elapsedMs = Date.now() - t0;
    logInjectPhase(logger, 'mode_button_timeout', {
      elapsedMs,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, reason: 'mode_button_timeout', elapsedMs };
  }

  try {
    await page.locator('#category-btn').first().waitFor({ state: 'visible', timeout: 5000 });
    logInjectPhase(logger, 'category_button_visible');
  } catch {
    logInjectPhase(logger, 'category_button_skipped', 'not visible within 5s');
  }

  await sleep(TISTORY_EDITOR_LEGACY_SETTLE_MS);
  logInjectPhase(logger, 'legacy_settle_complete', { ms: TISTORY_EDITOR_LEGACY_SETTLE_MS });
  return { ok: true, elapsedMs: Date.now() - t0 };
}

/**
 * Optional Playwright primer — opens mode layer only; full HTML switch is in-page (switchToHtmlEditorMode).
 * @param {import('playwright').Page} page
 */
async function openHtmlEditorModeViaPlaywright(page, logger, timing = TISTORY_INJECT_TIMING) {
  const modeBtn = page.locator('#editor-mode-layer-btn-open').first();
  const htmlItem = page.locator('#editor-mode-html').first();
  const afterHtmlModeMs = timing.afterHtmlModeMs ?? TISTORY_INJECT_TIMING.afterHtmlModeMs;

  try {
    const mceHtml = page.locator("div.mce-widget.mce-btn[role='button']").filter({
      has: page.locator('i.mce-txt'),
    });
    const mceCount = await mceHtml.count().catch(() => 0);
    if (mceCount > 0) {
      for (let i = 0; i < mceCount; i += 1) {
        const label = await mceHtml
          .nth(i)
          .locator('i.mce-txt')
          .innerText()
          .catch(() => '');
        if (String(label).trim() === 'HTML') {
          await mceHtml.nth(i).click({ timeout: 5000 });
          logInjectPhase(logger, 'playwright_mce_html_widget_click');
          await htmlItem.waitFor({ state: 'visible', timeout: 8000 }).catch(() => { });
          await htmlItem.click({ timeout: 5000 }).catch(() => { });
          await sleep(afterHtmlModeMs);
          return { ok: true, via: 'playwright_mce_html' };
        }
      }
    }

    await modeBtn.click({ timeout: 8000 });
    logInjectPhase(logger, 'playwright_mode_menu_open');
    await htmlItem.waitFor({ state: 'visible', timeout: 15000 });
    await htmlItem.click({ timeout: 5000 });
    logInjectPhase(logger, 'playwright_html_mode_selected', { afterHtmlModeMs });
    await sleep(afterHtmlModeMs);
    return { ok: true, via: 'playwright_locator' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logInjectPhase(logger, 'playwright_mode_menu_failed', message);
    return { ok: false, reason: message };
  }
}

async function probeHtmlModeUiOnPage(page) {
  return page.evaluate(() => {
    function findHtmlToolbarOpener() {
      for (const w of document.querySelectorAll("div.mce-widget.mce-btn[role='button']")) {
        const t = w.querySelector('i.mce-txt');
        if (t && (t.textContent || '').trim() === 'HTML') {
          return w;
        }
      }
      for (const b of document.querySelectorAll('button')) {
        const i = b.querySelector('i.mce-txt');
        if (i && (i.textContent || '').trim() === 'HTML') {
          return b;
        }
      }
      return null;
    }

    function isHtmlToolbarModeActive() {
      const opener = findHtmlToolbarOpener();
      if (!opener) {
        return false;
      }
      const st = getComputedStyle(opener);
      if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) {
        return false;
      }
      const r = opener.getBoundingClientRect();
      return r.width > 2 && r.height > 2;
    }

    function isMenuItemLikelyVisible(el) {
      if (!el) return false;
      const menu = el.closest('.mce-menu') || el.closest('.mce-floatpanel');
      if (menu) {
        const st = getComputedStyle(menu);
        if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) {
          return false;
        }
      }
      const r = el.getBoundingClientRect();
      return r.width > 2 && r.height > 2;
    }

    const htmlItem = document.querySelector('#editor-mode-html');
    let htmlModeSelected = false;
    if (htmlItem) {
      htmlModeSelected =
        htmlItem.classList.contains('mce-active') ||
        htmlItem.classList.contains('on') ||
        htmlItem.getAttribute('aria-checked') === 'true' ||
        htmlItem.getAttribute('aria-selected') === 'true';
    }

    function readLayerLabel() {
      const btn = document.querySelector('#editor-mode-layer-btn-open');
      const span =
        btn?.querySelector('.mce-txt') ||
        document.querySelector('#editor-mode-layer-btn .mce-txt');
      return String(span?.textContent || '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    const layerLabel = readLayerLabel();
    const htmlToolbar = isHtmlToolbarModeActive();
    let hasBodyCodeMirror = false;
    for (const node of document.querySelectorAll('.CodeMirror')) {
      if (node.CodeMirror && typeof node.CodeMirror.setValue === 'function') {
        hasBodyCodeMirror = true;
        break;
      }
    }

    const isHtmlLayer =
      htmlToolbar || (/html/i.test(layerLabel) && !/기본\s*모드/i.test(layerLabel));

    return {
      modeOpenBtn: !!document.querySelector('#editor-mode-layer-btn-open'),
      layerModeLabel: htmlToolbar ? 'HTML' : layerLabel,
      isHtmlToolbarModeActive: htmlToolbar,
      isHtmlModeLayerLabel: isHtmlLayer,
      htmlModeItem: !!htmlItem,
      htmlMenuVisible: htmlItem ? isMenuItemLikelyVisible(htmlItem) : false,
      htmlModeSelected,
      hasBodyCodeMirror,
      codeMirrorCount: document.querySelectorAll('.CodeMirror').length,
    };
  });
}

function isHtmlModeUiConfirmed(htmlProbe, options = {}) {
  if (!htmlProbe) {
    return false;
  }
  if (
    htmlProbe.isHtmlModeLayerLabel === true ||
    htmlProbe.isHtmlToolbarModeActive === true ||
    htmlProbe.htmlModeSelected === true
  ) {
    return true;
  }
  if (options.relax === true) {
    return htmlProbe.htmlModeItem === true || htmlProbe.hasBodyCodeMirror === true;
  }
  return false;
}

function isStrictHtmlModeInjectEnabled() {
  return process.env.JA_TISTORY_INJECT_RELAX_HTML_MODE !== '1';
}

async function probeEditorInjectState(page, minLen, marker) {
  return page.evaluate(({ minLen: minLength, marker: markerText, minBodyCmHeight }) => {
    function findHtmlToolbarOpener() {
      for (const w of document.querySelectorAll("div.mce-widget.mce-btn[role='button']")) {
        const t = w.querySelector('i.mce-txt');
        if (t && (t.textContent || '').trim() === 'HTML') {
          return w;
        }
      }
      for (const b of document.querySelectorAll('button')) {
        const i = b.querySelector('i.mce-txt');
        if (i && (i.textContent || '').trim() === 'HTML') {
          return b;
        }
      }
      return null;
    }

    function isHtmlToolbarModeActive() {
      const opener = findHtmlToolbarOpener();
      if (!opener) {
        return false;
      }
      const st = getComputedStyle(opener);
      if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) {
        return false;
      }
      const r = opener.getBoundingClientRect();
      return r.width > 2 && r.height > 2;
    }

    function isTitleTextarea(ta) {
      if (!ta) return false;
      if (ta.id === 'post-title-inp') return true;
      if (ta.classList?.contains('textarea_tit')) return true;
      if (ta.closest?.('.post-title, .title_area, .wrap_title')) return true;
      return false;
    }

    function getCodeMirrorWrapperElement(cm) {
      try {
        return typeof cm.getWrapperElement === 'function' ? cm.getWrapperElement() : null;
      } catch {
        return null;
      }
    }

    function isLikelyBodyHtmlCodeMirror(cm) {
      if (!cm || typeof cm.setValue !== 'function') return false;
      const input = typeof cm.getInputField === 'function' ? cm.getInputField() : null;
      if (input && isTitleTextarea(input)) return false;
      const wrap = getCodeMirrorWrapperElement(cm);
      if (!wrap || wrap.closest?.('#post-title-inp, .textarea_tit, .post-title, .title_area, .wrap_title')) {
        return false;
      }
      const st = getComputedStyle(wrap);
      if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) {
        return false;
      }
      const r = wrap.getBoundingClientRect();
      if (r.width <= 2 || r.height <= 2) return false;
      const inEditorShell = !!wrap.closest(
        '#editor-contents, .editor_contents, .editor-content, .area_editor, .contents_editor, .mce-tinymce, .post-editor',
      );
      const minH = isHtmlToolbarModeActive()
        ? Math.min(minBodyCmHeight, 20)
        : minBodyCmHeight;
      if (inEditorShell && r.height >= minH) return true;
      return r.height >= Math.max(minH, 80) && r.width >= 120;
    }

    function findBodyCodeMirrorLegacy() {
      for (const ta of document.querySelectorAll('textarea')) {
        if (isTitleTextarea(ta)) continue;
        const sib = ta.nextElementSibling;
        if (sib?.classList?.contains('CodeMirror') && sib.CodeMirror) {
          return sib.CodeMirror;
        }
      }
      for (const node of document.querySelectorAll('.CodeMirror')) {
        if (node.CodeMirror && typeof node.CodeMirror.setValue === 'function') {
          if (
            node.closest?.(
              '#post-title-inp, .textarea_tit, .post-title, .title_area, .wrap_title',
            )
          ) {
            continue;
          }
          return node.CodeMirror;
        }
      }
      return null;
    }

    function findBodyCodeMirror() {
      const legacy = findBodyCodeMirrorLegacy();
      if (legacy) {
        return legacy;
      }
      const candidates = [];
      const seen = new Set();
      function push(cm) {
        if (!cm || seen.has(cm) || !isLikelyBodyHtmlCodeMirror(cm)) return;
        seen.add(cm);
        candidates.push(cm);
      }
      for (const ta of document.querySelectorAll('textarea')) {
        if (isTitleTextarea(ta)) continue;
        const sib = ta.nextElementSibling;
        if (sib?.classList?.contains('CodeMirror') && sib.CodeMirror) push(sib.CodeMirror);
      }
      for (const node of document.querySelectorAll('.CodeMirror')) {
        if (node.CodeMirror) push(node.CodeMirror);
      }
      if (!candidates.length) return null;
      if (candidates.length === 1) return candidates[0];
      let best = candidates[0];
      let bestArea = 0;
      for (const cm of candidates) {
        const wrap = getCodeMirrorWrapperElement(cm);
        if (!wrap) continue;
        const r = wrap.getBoundingClientRect();
        const area = r.width * r.height;
        if (area > bestArea) {
          bestArea = area;
          best = cm;
        }
      }
      return best;
    }

    function readEditorModeLayerLabel() {
      const btn = document.querySelector('#editor-mode-layer-btn-open');
      const span =
        btn?.querySelector('.mce-txt') ||
        document.querySelector('#editor-mode-layer-btn .mce-txt');
      return String(span?.textContent || '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function isMenuItemLikelyVisible(el) {
      if (!el) return false;
      const menu = el.closest('.mce-menu') || el.closest('.mce-floatpanel');
      if (menu) {
        const st = getComputedStyle(menu);
        if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) {
          return false;
        }
      }
      const r = el.getBoundingClientRect();
      return r.width > 2 && r.height > 2;
    }

    const cm = findBodyCodeMirror();
    let value = '';
    if (cm) {
      try {
        value = cm.getValue();
      } catch {
        value = '';
      }
    }

    const htmlItem = document.querySelector('#editor-mode-html');
    let htmlModeSelected = false;
    if (htmlItem) {
      htmlModeSelected =
        htmlItem.classList.contains('mce-active') ||
        htmlItem.classList.contains('on') ||
        htmlItem.getAttribute('aria-checked') === 'true' ||
        htmlItem.getAttribute('aria-selected') === 'true';
    }

    const chars = value.length;
    const hasMin = chars >= minLength;
    const hasMarker = !markerText || value.replace(/\s+/g, ' ').indexOf(markerText) >= 0;
    const htmlToolbar = isHtmlToolbarModeActive();
    const layerLabel = htmlToolbar ? 'HTML' : readEditorModeLayerLabel();
    const htmlModeUiOk =
      htmlToolbar ||
      (/html/i.test(layerLabel) && !/기본\s*모드/i.test(layerLabel)) ||
      htmlModeSelected === true;

    return {
      ok: hasMin && hasMarker,
      phase: cm ? 'body_codemirror' : 'no_body_codemirror',
      chars,
      head: value.slice(0, 120),
      modeOpenBtn: !!document.querySelector('#editor-mode-layer-btn-open'),
      layerModeLabel: layerLabel,
      isHtmlToolbarModeActive: htmlToolbar,
      htmlModeItem: !!htmlItem,
      htmlMenuVisible: htmlItem ? isMenuItemLikelyVisible(htmlItem) : false,
      htmlModeSelected,
      htmlModeUiOk,
      codeMirrorCount: document.querySelectorAll('.CodeMirror').length,
      injectEvents: Array.isArray(window.__jablyTistoryInjectDebug?.events)
        ? window.__jablyTistoryInjectDebug.events.slice(-8)
        : [],
    };
  }, { minLen, marker, minBodyCmHeight: TISTORY_INJECT_TIMING.htmlModeMinBodyCmHeightPx });
}

function stripTitleAndTagsNode(html) {
  let res = html;
  res = res.replace(/<p>[^<]*((권장|추천|해시|관련|참고)\s*태그|tags?)\s*[：:][\s\S]*?<\/p>/i, '');
  res = res.replace(/<p>[\s]*((#[^\s#<]+[\s]*)+)<\/p>(?![\s\S]*<p>)/gi, '');
  res = res.replace(/<h[1-3]\b[^>]*>[\s\S]*?<\/h[1-3]>/i, '');
  return res;
}

async function waitForEditorInject(page, expectedHtml, logger, timeoutMs = INJECT_WAIT_TIMEOUT_MS) {
  const expected = stripTitleAndTagsNode(String(expectedHtml || ''));
  const minChars = Math.min(120, Math.max(20, Math.floor(expected.length * 0.25)));
  const snippet = expected.replace(/\s+/g, ' ').trim().slice(0, 48);
  const deadline = Date.now() + timeoutMs;
  let lastLogAt = 0;
  let lastState = { phase: 'pending', chars: 0, head: '' };

  logInjectPhase(logger, 'poll_start', { minChars, snippetHead: snippet.slice(0, 32), timeoutMs });

  while (Date.now() < deadline) {
    lastState = await probeEditorInjectState(page, minChars, snippet);

    if (lastState.ok) {
      const htmlProbe = await probeHtmlModeUiOnPage(page);
      const relaxHtmlMode = !isStrictHtmlModeInjectEnabled();
      const htmlUiConfirmed = isHtmlModeUiConfirmed(htmlProbe, { relax: relaxHtmlMode });
      logInjectPhase(logger, 'poll_success', {
        chars: lastState.chars,
        phase: lastState.phase,
        elapsedMs: timeoutMs - (deadline - Date.now()),
        htmlModeItem: htmlProbe?.htmlModeItem,
        htmlModeSelected: htmlProbe?.htmlModeSelected,
        htmlMenuVisible: htmlProbe?.htmlMenuVisible,
        htmlModeUiOk: htmlUiConfirmed,
        strictHtmlMode: !relaxHtmlMode,
      });
      if (!htmlUiConfirmed) {
        logInjectPhase(logger, 'html_mode_not_confirmed', htmlProbe);
        return {
          ok: false,
          reason: 'html_mode_not_confirmed',
          chars: lastState.chars,
          head: lastState.head,
          phase: lastState.phase,
          htmlProbe,
        };
      }
      logger?.info(`Tistory CodeMirror content detected (${lastState.chars} chars).`);
      return {
        ok: true,
        chars: lastState.chars,
        head: lastState.head,
        phase: lastState.phase,
        htmlModeUiOk: htmlUiConfirmed,
        htmlProbe,
      };
    }

    if (Date.now() - lastLogAt >= INJECT_DEBUG_LOG_INTERVAL_MS) {
      logInjectPhase(logger, 'poll_tick', {
        phase: lastState.phase,
        chars: lastState.chars,
        head: lastState.head?.slice(0, 60),
        codeMirrorCount: lastState.codeMirrorCount,
        modeOpenBtn: lastState.modeOpenBtn,
        htmlModeItem: lastState.htmlModeItem,
        htmlModeSelected: lastState.htmlModeSelected,
        htmlModeUiOk: lastState.htmlModeUiOk,
        injectEvents: lastState.injectEvents,
      });
      lastLogAt = Date.now();
    }

    await sleep(INJECT_POLL_MS);
  }

  logInjectPhase(logger, 'poll_timeout', lastState);
  return {
    ok: false,
    reason: 'inject_timeout',
    chars: lastState.chars ?? 0,
    head: lastState.head ?? '',
    phase: lastState.phase ?? 'timeout',
  };
}

/**
 * Inject Gemini HTML into Tistory newpost CodeMirror (Playwright only).
 *
 * @param {import('playwright').Page} page
 * @param {string} html
 * @param {{ isPublic?: boolean, autoPublish?: boolean, deferAutoPublish?: boolean, blogUrl?: string, categoryItemElementId?: string, categoryItemId?: string }} publishOpts
 * @param {object} [logger]
 * @param {{ openTabCount?: number }} [options]
 */
async function injectHtmlToNewPost(page, html, publishOpts = {}, logger, options = {}) {
  const resolved = resolvePublishOptsFromHtml(html, publishOpts);
  const opts = {
    isPublic: resolved.isPublic,
    autoPublish: resolved.autoPublish,
    deferAutoPublish: resolved.deferAutoPublish,
    forcePostTitle: resolved.forcePostTitle,
    forceTags: resolved.forceTags,
  };
  const payload = String(html ?? '');
  const debugEnabled = isTistoryInjectDebugEnabled();
  const injectTiming = resolveInjectTiming({
    slowProfile: debugEnabled || process.env.JA_TISTORY_INJECT_SLOW === '1',
  });
  const injectT0 = Date.now();

  if (resolved.placeholderCount > 0) {
    logger?.info(
      `Tistory placeholders detected: count=${resolved.placeholderCount}${opts.deferAutoPublish ? ' — deferAutoPublish=true' : ''}`,
    );
  }

  logInjectPhase(logger, 'begin', {
    htmlChars: payload.length,
    autoPublish: opts.autoPublish,
    deferAutoPublish: opts.deferAutoPublish,
    isPublic: opts.isPublic,
    pageUrl: page.url(),
    openTabCount: options.openTabCount ?? null,
    debugEnabled,
  });

  const url = page.url();
  if (!isOnTistoryNewPost(url)) {
    logInjectPhase(logger, 'wrong_page', url);
    return { ok: false, reason: TISTORY_ERROR.SESSION_EXPIRED, detail: url };
  }

  await dismissTistoryDraftResumePopup(page, logger, { quick: true });

  const readyResult = await waitForTistoryEditorReady(page, logger);
  if (!readyResult.ok) {
    await dumpTistoryEditorSnapshot(page, logger, {
      label: 'editor_not_ready',
      openTabCount: options.openTabCount,
      readyResult,
    });
    return {
      ok: false,
      reason: readyResult.reason || 'editor_not_ready',
      detail: url,
      chars: 0,
    };
  }

  await resetTistoryCoverThumbnailOnPage(page, logger);
  await injectTistoryPlaceholderGate(page);
  await dismissTistoryDraftResumePopup(page, logger, { quick: true });

  // HTML mode switch runs in MAIN world (mce-widget + #editor-mode-html); avoid double-click race with Playwright.
  logInjectPhase(logger, 'html_mode_delegated', 'main_world switchToHtmlEditorMode');

  const evaluatePayload = {
    prefillHtml: payload,
    publishOpts: {
      ...opts,
      categoryItemId: String(
        publishOpts.categoryItemElementId || publishOpts.categoryItemId || '',
      ).trim(),
    },
    debug: debugEnabled,
    timing: injectTiming,
    strictHtmlMode: isStrictHtmlModeInjectEnabled(),
  };
  logInjectPhase(logger, 'strict_html_mode', { enabled: evaluatePayload.strictHtmlMode });
  logInjectPhase(logger, 'inject_timing', injectTiming);

  try {
    await page.evaluate(tistoryEditorModeClickMain, evaluatePayload);
    logInjectPhase(logger, 'main_world_script_dispatched', {
      htmlChars: payload.length,
      autoPublish: opts.autoPublish,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logInjectPhase(logger, 'main_world_script_error', message);
    await dumpTistoryEditorSnapshot(page, logger, {
      label: 'evaluate_error',
      openTabCount: options.openTabCount,
    });
    return { ok: false, reason: 'browser_error', detail: message, chars: 0 };
  }

  const waitResult = await waitForEditorInject(page, payload, logger);
  if (!waitResult.ok) {
    await dumpTistoryEditorSnapshot(page, logger, {
      label: 'inject_timeout',
      openTabCount: options.openTabCount,
      waitResult,
      readyResult,
    });
    return {
      ok: false,
      reason: waitResult.reason || 'inject_timeout',
      detail: waitResult.head,
      chars: waitResult.chars,
      phase: waitResult.phase,
    };
  }

  logInjectPhase(logger, 'inject_complete', {
    chars: waitResult.chars,
    elapsedMs: Date.now() - injectT0,
    head: waitResult.head?.slice(0, 80),
  });

  if (opts.autoPublish && !opts.deferAutoPublish) {
    const forcedTitle =
      typeof publishOpts.forcePostTitle === 'string' ? publishOpts.forcePostTitle.trim() : '';
    const autoTitle = forcedTitle || extractFirstH1PlainTextFromHtml(payload) || '인공지능의 역사';

    // Re-fill title AFTER HTML inject (HTML mode switch clears the title field)
    // Use Playwright fill() which simulates real typing and updates React/Vue state
    try {
      const titleSelector = '#post-title-inp, textarea.textarea_tit';
      const titleLocator = page.locator(titleSelector).first();
      await titleLocator.click({ timeout: 3000 });
      await titleLocator.fill(autoTitle, { timeout: 3000 });
      logInjectPhase(logger, 'title_refilled_after_html_mode', { title: autoTitle.slice(0, 60) });
    } catch (titleErr) {
      logInjectPhase(logger, 'title_refill_skipped', titleErr instanceof Error ? titleErr.message : String(titleErr));
    }
    await page.waitForTimeout(500);

    const tagCount = (html.match(/이미지\s*삽입\s*공간/gi) || []).length;
    const harvest = await harvestPublishedPost(page, {
      logger,
      expectedTitle: autoTitle,
      forcePostTitle: forcedTitle,
      blogUrl: publishOpts.blogUrl || '',
      debugFixtureHarvest: publishOpts.debugFixtureHarvest === true,
      prePublishWaitMs: 5600 + tagCount * 320 + 2500,
    });

    if (!harvest.ok || !harvest.url) {
      return {
        ok: false,
        reason: harvest.reason || 'publish_harvest_failed',
        detail: harvest.url || harvest.source || '',
        chars: waitResult.chars,
      };
    }

    logPublishedJsonLine(logger, harvest);
    return {
      ok: true,
      chars: waitResult.chars,
      head: waitResult.head,
      autoPublish: opts.autoPublish,
      deferAutoPublish: opts.deferAutoPublish,
      publishedUrl: harvest.url,
      publishedTitle:
        harvest.title || forcedTitle || extractFirstH1PlainTextFromHtml(payload),
      publishSource: harvest.source || '',
      placeholderCount: resolved.placeholderCount,
    };
  }

  return {
    ok: true,
    chars: waitResult.chars,
    head: waitResult.head,
    autoPublish: opts.autoPublish,
    deferAutoPublish: opts.deferAutoPublish,
    placeholderCount: resolved.placeholderCount,
  };
}

/**
 * Final publish after deferred image flow — gate must pass (fail-closed).
 * @param {import('playwright').Page} page
 */
async function publishTistoryPostAfterGate(page, html, publishOpts = {}, logger) {
  const forcedTitle =
    typeof publishOpts.forcePostTitle === 'string' ? publishOpts.forcePostTitle.trim() : '';
  const expectedTitle = forcedTitle || extractFirstH1PlainTextFromHtml(html);
  const coverDataUrl = String(publishOpts.coverDataUrl || publishOpts.lastImageDataUrl || '').trim();
  if (coverDataUrl.startsWith('data:image')) {
    logger?.info?.(
      `[Tistory] publish with representative cover (${coverDataUrl.slice(0, 48)}…)`,
    );
  }
  const defaultLayerOpenDelayMs = process.env.JA_TISTORY_LAYER_DELAY !== undefined
    ? parseFloat(process.env.JA_TISTORY_LAYER_DELAY) * 1000
    : 500;
  const layerOpenDelayMs =
    typeof publishOpts.layerOpenDelayMs === 'number' ? publishOpts.layerOpenDelayMs : defaultLayerOpenDelayMs;
  const coverWaitMs = coverDataUrl.startsWith('data:image')
    ? publishOpts.coverUploadWaitMs != null
      ? publishOpts.coverUploadWaitMs
      : 3500
    : 0;
  // Reduce prePublishWaitMs since we don't need to wait 5.6s
  const prePublishWaitMs =
    typeof publishOpts.prePublishWaitMs === 'number'
      ? publishOpts.prePublishWaitMs
      : layerOpenDelayMs + coverWaitMs + 1000;

  const publishTrigger = await triggerTistoryPublishLayerFlow(
    page,
    {
      isPublic: publishOpts.isPublic === true,
      visibility: publishOpts.visibility,
      categoryItemElementId: publishOpts.categoryItemElementId || publishOpts.categoryItemId || '',
      layerOpenDelayMs,
      coverDataUrl,
      coverUploadWaitMs: publishOpts.coverUploadWaitMs,
    },
    logger,
  );

  if (!publishTrigger.ok) {
    return {
      ok: false,
      reason: publishTrigger.reason || 'placeholder_gate_failed',
      gate: publishTrigger.gate,
    };
  }

  const harvest = await harvestPublishedPost(page, {
    logger,
    expectedTitle,
    forcePostTitle: forcedTitle,
    blogUrl: publishOpts.blogUrl || '',
    debugFixtureHarvest: publishOpts.debugFixtureHarvest === true,
    prePublishWaitMs,
  });

  if (!harvest.ok || !harvest.url) {
    logger?.info?.(
      `[Tistory] publish harvest failed: ${JSON.stringify({
        reason: harvest.reason || 'publish_harvest_failed',
        source: harvest.source || 'unresolved',
        pageUrl: String(page.url() || '').slice(0, 120),
      })}`,
    );
    return {
      ok: false,
      reason: harvest.reason || 'publish_harvest_failed',
      gate: publishTrigger.gate,
      harvest,
    };
  }

  logger?.info?.(
    `[Tistory] resolvePublishedPost: ${JSON.stringify({
      ok: true,
      source: harvest.source || '',
      url: harvest.url.slice(0, 120),
      title: (harvest.title || expectedTitle || '').slice(0, 80),
    })}`,
  );
  logPublishedJsonLine(logger, harvest);
  return {
    ok: true,
    publishedUrl: harvest.url,
    publishedTitle: harvest.title || expectedTitle,
    publishSource: harvest.source || '',
    gate: publishTrigger.gate,
  };
}

async function runInjectCli() {
  const args = parseInjectCliArgs();
  const logger = createLogger(ENGINE);
  let context = null;
  let exitCode = EXIT.SUCCESS;

  if (!args.htmlFile) {
    exitCode = fail(logger, 'missing_html_file', 'Pass --html-file build/gemini-draft.html');
    return exitCode;
  }

  if (!args.newPostUrl) {
    exitCode = fail(logger, TISTORY_ERROR.INVALID_BLOG_URL, 'Pass --blog-url or --newpost-url');
    return exitCode;
  }

  const htmlRead = readHtmlFromFile(args.htmlFile);
  if (!htmlRead.ok) {
    exitCode = fail(logger, htmlRead.reason, htmlRead.path);
    return exitCode;
  }

  logger.info('Tistory editor inject CLI (Playwright)');
  logger.info(`HTML file: ${htmlRead.path} (${htmlRead.html.length} chars)`);
  logger.info(`Target newpost: ${args.newPostUrl}`);
  logger.info(`Profile directory: ${args.profileDir}`);
  logger.info(
    `Publish opts: autoPublish=${args.publishOpts.autoPublish}, deferAutoPublish=${args.publishOpts.deferAutoPublish}, isPublic=${args.publishOpts.isPublic}`,
  );

  try {
    context = await chromium.launchPersistentContext(args.profileDir, {
      headless: args.headless === true,
      channel: 'chrome',
      args: CHROME_STEALTH_ARGS,
      ignoreDefaultArgs: PLAYWRIGHT_STEALTH_IGNORE_DEFAULT_ARGS,
    });
    await applyPlaywrightStealthInitScript(context);

    const page = context.pages()[0] || (await context.newPage());
    logger.info('Browser launched.');

    logger.info(`Navigating to ${args.newPostUrl}`);
    await page.goto(args.newPostUrl, {
      waitUntil: 'domcontentloaded',
      timeout: TISTORY_PAGE_LOAD_TIMEOUT_MS,
    });
    await page.waitForTimeout(2000);

    const currentUrl = page.url();
    if (isSessionExpiredRedirect(currentUrl) || isOnKakaoLogin(currentUrl)) {
      exitCode = fail(
        logger,
        TISTORY_ERROR.SESSION_EXPIRED,
        'Run playwright_tistory_login.js first',
      );
      return exitCode;
    }

    if (!isOnTistoryNewPost(currentUrl)) {
      exitCode = fail(logger, TISTORY_ERROR.SESSION_EXPIRED, `got ${currentUrl}`);
      return exitCode;
    }

    const injectResult = await injectHtmlToNewPost(
      page,
      htmlRead.html,
      {
        ...args.publishOpts,
        blogUrl: args.blogUrl,
      },
      logger,
    );

    logInjectJsonLine(logger, injectResult);

    if (!injectResult.ok) {
      exitCode = fail(logger, injectResult.reason, injectResult.detail);
      return exitCode;
    }

    logger.info(`HTML visible in CodeMirror (${injectResult.chars} chars).`);
    logger.result(RESULT.SUCCESS, 'HTML injected to CodeMirror');
    exitCode = EXIT.SUCCESS;
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    exitCode = fail(logger, 'browser_error', error instanceof Error ? error.message : String(error));
  } finally {
    if (context) {
      logger.info(`Holding browser open for ${POST_SUCCESS_HOLD_MS / 1000} seconds before closing...`);
      try {
        const page = context.pages()[0];
        if (page) {
          await page.waitForTimeout(POST_SUCCESS_HOLD_MS);
        } else {
          await sleep(POST_SUCCESS_HOLD_MS);
        }
      } catch {
        await sleep(POST_SUCCESS_HOLD_MS);
      }

      await context.close().catch((closeError) => {
        logger.error(closeError instanceof Error ? closeError.message : String(closeError));
      });
      logger.info('Browser closed.');
    }

    process.exitCode = exitCode;
  }

  return exitCode;
}

/**
 * MAIN-world: switch HTML → 기본모드, find placeholder block, insert <img dataUrl>.
 * Simplified port of tistoryPasteImageAndPublishMain (insert only, no publish).
 */
function tistoryPasteImageAtPlaceholderMain(arg) {
  let dataUrl = '';
  let fullPlaceholderLine = '';
  if (typeof arg === 'string') {
    dataUrl = arg;
  } else if (arg && typeof arg === 'object') {
    dataUrl = typeof arg.dataUrl === 'string' ? arg.dataUrl : '';
    fullPlaceholderLine =
      typeof arg.fullPlaceholderLine === 'string' ? arg.fullPlaceholderLine : '';
  }
  return new Promise((resolve) => {
    const L = (...a) => console.log('[ja_test][TistoryImagePaste]', ...a);
    try {
      window.alert = function alertStub() { };
      window.confirm = function confirmStub() {
        return true;
      };
    } catch {
      /* ignore */
    }

    function getTinymceBody() {
      const sels = [
        'iframe.tox-edit-area__iframe',
        'iframe#editor-tistory_ifr',
        'iframe[id^="tistory_"]',
        'iframe.mce-edit-area',
      ];
      for (const s of sels) {
        const fr = document.querySelector(s);
        const doc = fr?.contentDocument || fr?.contentWindow?.document;
        const b = doc?.body;
        if (b) return b;
      }
      for (const fr of document.querySelectorAll('iframe')) {
        const doc = fr.contentDocument || fr.contentWindow?.document;
        const b = doc?.body;
        if (b?.classList?.contains('mce-content-body') || b?.getAttribute('id') === 'tinymce') {
          return b;
        }
      }
      return null;
    }

    function dispatchClickChain(el) {
      if (!el) return;
      try {
        el.click();
      } catch {
        /* ignore */
      }
    }

    function openHtmlMenuThenBasicMode(done) {
      let attempts = 0;
      function tryClickBasicMode() {
        const basic = document.querySelector('#editor-mode-kakao-tistory');
        if (basic) {
          dispatchClickChain(basic);
          window.setTimeout(done, 1000);
          return true;
        }
        return false;
      }
      function tick() {
        attempts += 1;
        if (tryClickBasicMode()) return;
        if (attempts === 1 || attempts % 5 === 0) {
          const opener = document.querySelector('#editor-mode-layer-btn-open');
          if (opener) dispatchClickChain(opener);
        }
        if (attempts > 50) {
          done();
          return;
        }
        window.setTimeout(tick, 200);
      }
      tick();
    }

    function getTinymceEditorForBody(bodyEl) {
      try {
        const w = bodyEl?.ownerDocument?.defaultView;
        if (!w) return null;
        const topWin = w.top || w;
        const tm = topWin.tinymce || w.tinymce;
        if (!tm || !tm.editors) return null;
        const raw = tm.editors;
        const list = Array.isArray(raw)
          ? raw
          : Object.keys(raw)
            .map((k) => raw[k])
            .filter(Boolean);
        for (let i = 0; i < list.length; i += 1) {
          const ed = list[i];
          if (ed && typeof ed.getBody === 'function' && ed.getBody() === bodyEl) {
            return ed;
          }
        }
        if (tm.activeEditor && tm.activeEditor.getBody?.() === bodyEl) return tm.activeEditor;
      } catch (e) {
        L('getTinymceEditorForBody err', e);
      }
      return null;
    }

    function notifyEditorContentChanged(ed, bodyEl) {
      if (ed) {
        try {
          ed.nodeChanged();
        } catch {
          /* ignore */
        }
        try {
          if (typeof ed.setDirty === 'function') ed.setDirty(true);
        } catch {
          /* ignore */
        }
        try {
          ed.fire('Change');
          ed.fire('input');
        } catch {
          /* ignore */
        }
      }
      try {
        bodyEl.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        bodyEl.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      } catch {
        /* ignore */
      }
    }

    function insertImage() {
      const body = getTinymceBody();
      const needle = String(fullPlaceholderLine || '').trim();
      const url = String(dataUrl || '');
      if (!body || !needle || !url.startsWith('data:image')) {
        resolve({
          ok: false,
          reason: 'missing_body_or_data',
          imgCount: 0,
          placeholderMatched: false,
          removedPlaceholder: false,
        });
        return;
      }

      function depthUnderRoot(el) {
        let d = 0;
        let x = el;
        while (x && x !== body) {
          d += 1;
          x = x.parentElement;
        }
        return d;
      }

      function normalizeForPlaceholderMatch(text) {
        return String(text ?? '')
          .replace(/\u200b/g, '')
          .replace(/\s+/g, ' ')
          .trim();
      }

      function findTightestPlaceholderBlock() {
        const needleNorm = normalizeForPlaceholderMatch(needle);
        const labelRe = /이미지\s*삽입\s*공간/i;
        const sel =
          'p, div, section, article, header, footer, aside, li, td, th, blockquote, figcaption, h1, h2, h3, h4, h5, h6';

        function collectCandidates(matchFn) {
          const candidates = [];
          for (const el of body.querySelectorAll(sel)) {
            const t = normalizeForPlaceholderMatch(el.textContent);
            if (!matchFn(t)) continue;
            candidates.push({ el, len: t.length, depth: depthUnderRoot(el) });
          }
          return candidates;
        }

        function pickBest(candidates) {
          if (candidates.length === 0) return null;
          candidates.sort((a, b) => {
            if (a.len !== b.len) return a.len - b.len;
            if (a.depth !== b.depth) return b.depth - a.depth;
            const cmp = a.el.compareDocumentPosition(b.el);
            if (cmp & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
            if (cmp & Node.DOCUMENT_POSITION_PRECEDING) return 1;
            return 0;
          });
          return candidates[0];
        }

        let best = pickBest(
          collectCandidates((t) => needleNorm.length > 0 && t.includes(needleNorm)),
        );
        if (!best) {
          best = pickBest(collectCandidates((t) => labelRe.test(t)));
          if (best) {
            L('needle miss; label-anchor fallback', { needleLen: needleNorm.length });
          }
        }
        if (!best) return null;
        L('tightest placeholder hit', best.el.tagName, { textLen: best.len, depth: best.depth });
        return best.el;
      }

      const hit = findTightestPlaceholderBlock();
      const ed = getTinymceEditorForBody(body);
      const doc = body.ownerDocument;
      let removedPlaceholder = false;

      function applyDomInsertAndRemovePlaceholder() {
        const imgP = doc.createElement('p');
        const img = doc.createElement('img');
        img.src = url;
        img.alt = '';
        img.style.maxWidth = '100%';
        img.style.height = 'auto';
        imgP.appendChild(img);

        if (hit && hit.parentNode) {
          const braceTail = hit.nextElementSibling;
          const hitTextNorm = normalizeForPlaceholderMatch(hit.textContent);
          const needleNorm = normalizeForPlaceholderMatch(needle);
          const isLargeBlock = hitTextNorm.length > needleNorm.length + 50;

          if (!isLargeBlock) {
            hit.parentNode.insertBefore(imgP, hit.nextSibling);
            L('inserted <img> after placeholder block');
            try {
              hit.remove();
              removedPlaceholder = true;
              L('removed placeholder block only (tightest match)');
            } catch (e) {
              L('remove placeholder failed', e);
            }
          } else {
            L('hit block too large (' + hitTextNorm.length + ' vs ' + needleNorm.length + '), doing inline replacement to preserve body');
            let replaced = false;
            try {
              const walker = doc.createTreeWalker(hit, 4 /* NodeFilter.SHOW_TEXT */, null, false);
              let node;
              while ((node = walker.nextNode())) {
                const nodeNorm = normalizeForPlaceholderMatch(node.nodeValue);
                if (nodeNorm.includes('이미지') && nodeNorm.includes('삽입')) {
                  node.parentNode.insertBefore(imgP, node);

                  // Safely remove the placeholder text from the text node
                  let newValue = node.nodeValue.replace(needle, '');
                  if (newValue === node.nodeValue) {
                    try {
                      // Try flexible whitespace match of the exact needle
                      const needleRe = new RegExp(needle.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&').replace(/\\s\+/g, '\\s+'), 'i');
                      newValue = node.nodeValue.replace(needleRe, '');
                    } catch (e) { }
                  }

                  if (newValue === node.nodeValue) {
                    // Wording might be slightly different. Remove the entire placeholder starting from '이미지 삽입공간' to bracket or end of node.
                    newValue = node.nodeValue.replace(/\[?\s*이미지\s*삽입\s*공간[\s\S]*?(\]|$)/i, '');
                  }

                  node.nodeValue = newValue;
                  replaced = true;
                  removedPlaceholder = true;
                  L('replaced placeholder in text node of large block safely');
                  break;
                }
              }
            } catch (e) {
              L('walker error', e);
            }
            if (!replaced) {
              try {
                const re = /\[?\s*이미지\s*삽입\s*공간[^\n\]}]*[\]}]?/i;
                if (re.test(hit.innerHTML)) {
                  hit.innerHTML = hit.innerHTML.replace(re, imgP.outerHTML);
                  removedPlaceholder = true;
                  L('replaced placeholder via innerHTML in large block');
                } else {
                  hit.insertBefore(imgP, hit.firstChild);
                  L('regex miss in large block, prepended image');
                }
              } catch (e) {
                hit.insertBefore(imgP, hit.firstChild);
              }
            }
          }

          if (braceTail?.parentNode && (!isLargeBlock || !removedPlaceholder)) {
            const tailText = normalizeForPlaceholderMatch(braceTail.textContent);
            if (/^\{[^}]+\}$/.test(tailText)) {
              try {
                braceTail.remove();
                L('removed adjacent brace-only tail block');
              } catch (e) {
                L('remove brace tail failed', e);
              }
            }
          }
        } else {
          body.appendChild(imgP);
          L('placeholder not found; appended <img> at body end');
        }
      }

      try {
        if (ed) {
          try {
            ed.focus();
          } catch {
            /* ignore */
          }
          const um = ed.undoManager;
          if (um && typeof um.transact === 'function') {
            um.transact(applyDomInsertAndRemovePlaceholder);
            L('applied via TinyMCE undoManager.transact');
          } else {
            applyDomInsertAndRemovePlaceholder();
          }
        } else {
          applyDomInsertAndRemovePlaceholder();
        }
        notifyEditorContentChanged(ed, body);
      } catch (e) {
        L('insertImage err', e);
        resolve({
          ok: false,
          reason: 'insert_exception',
          imgCount: 0,
          placeholderMatched: !!hit,
          removedPlaceholder,
        });
        return;
      }

      const imgCount = body.querySelectorAll('img').length;
      resolve({
        ok: imgCount > 0,
        imgCount,
        reason: imgCount > 0 ? 'ok' : 'no_img_in_body',
        placeholderMatched: !!hit,
        removedPlaceholder,
      });
    }

    openHtmlMenuThenBasicMode(insertImage);
  });
}

function logImagePasteJsonLine(logger, payload) {
  const body = {
    ok: payload?.ok === true,
    imgCount: payload?.imgCount ?? 0,
    reason: payload?.reason ?? '',
    placeholderMatched: payload?.placeholderMatched === true,
    removedPlaceholder: payload?.removedPlaceholder === true,
    queueIndex: payload?.queueIndex ?? 0,
    queueTotal: payload?.queueTotal ?? 1,
  };
  logger.info(`[Tistory] [IMAGE_PASTE] ${JSON.stringify(body)}`);
  return body;
}

/**
 * Paste Gemini clipboard image (data URL) at Tistory placeholder in basic mode editor.
 * @param {object} [options] queueIndex, queueTotal
 */
async function pasteImageAtPlaceholder(page, dataUrl, fullPlaceholderLine, logger, options = {}) {
  const queueIndex = typeof options.queueIndex === 'number' ? options.queueIndex : 0;
  const queueTotal = typeof options.queueTotal === 'number' ? options.queueTotal : 1;

  logger?.info(
    `Tistory image paste slot ${queueIndex + 1}/${queueTotal}: placeholder="${String(fullPlaceholderLine || '').slice(0, 80)}", dataUrl prefix=${String(dataUrl || '').slice(0, 32)}`,
  );

  try {
    await page.bringToFront();
  } catch {
    /* ignore */
  }

  let result = await page.evaluate(tistoryPasteImageAtPlaceholderMain, {
    dataUrl,
    fullPlaceholderLine,
  });
  if (result && typeof result.then === 'function') {
    result = await result;
  }

  logImagePasteJsonLine(logger, {
    ...result,
    queueIndex,
    queueTotal,
  });

  if (!result?.ok) {
    return {
      ok: false,
      reason: result?.reason || 'paste_failed',
      imgCount: result?.imgCount ?? 0,
      placeholderMatched: result?.placeholderMatched === true,
      removedPlaceholder: result?.removedPlaceholder === true,
      queueIndex,
      queueTotal,
    };
  }

  return {
    ok: true,
    imgCount: result.imgCount,
    reason: 'ok',
    placeholderMatched: result?.placeholderMatched === true,
    removedPlaceholder: result?.removedPlaceholder === true,
    queueIndex,
    queueTotal,
  };
}

if (require.main === module) {
  runInjectCli().catch((error) => {
    const logger = createLogger(ENGINE);
    logger.error(error instanceof Error ? error.message : String(error));
    logger.result(RESULT.FAILED, 'Unhandled script error.');
    process.exitCode = EXIT.FAILED;
  });
}

module.exports = {
  tistoryEditorModeClickMain,
  injectHtmlToNewPost,
  publishTistoryPostAfterGate,
  resolvePublishOptsFromHtml,
  waitForEditorInject,
  waitForTistoryEditorReady,
  openHtmlEditorModeViaPlaywright,
  readHtmlFromFile,
  parseInjectCliArgs,
  logInjectJsonLine,
  logInjectPhase,
  runInjectCli,
  tistoryPasteImageAtPlaceholderMain,
  pasteImageAtPlaceholder,
  logImagePasteJsonLine,
  normalizePublishOpts,
  TISTORY_EDITOR_LEGACY_SETTLE_MS,
  TISTORY_INJECT_TIMING,
  resolveInjectTiming,
};
