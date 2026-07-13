'use strict';

/**
 * @file gemini_image.js
 * @description Gemini 이미지 생성 자동화
 * @purpose  Gemini 웹 UI에서 이미지 생성 도구를 열고, imgplace 텍스트를 기반으로
 *           이미지를 생성·저장하는 흐름을 자동화.
 * @promptFiles  automation/prompts/gemini-image-style.txt (3D 파스텔 스타일 suffix)
 * @exports  buildGeminiImagePrompt, runGeminiImageFlow, ...
 * @seeAlso  gemini_image_finalize.js, gemini_image_flow_lock.js, playwright_gemini_image.js
 */


const fs = require('fs');
const path = require('path');
const { sleep } = require('./common');
const { SELECTORS, waitForGeminiSpaReady, GEMINI_FLOW_RETRY_MAX } = require('./gemini_common');
const isGeminiImageDebugEnabled = require('./_legacy/gemini_image_debug').isGeminiImageDebugEnabled;
const dumpGeminiImageSnapshot = require('./_legacy/gemini_image_debug').dumpGeminiImageSnapshot;

const IMAGE_TOOL_FILL_TOTAL_MS = 18_000;
const IMAGE_UPLOAD_TOOLS_MENU_OPEN_MS = 1500;
const IMAGE_READY_POLL_MAX_MS = 120_000;
const IMAGE_POLL_INTERVAL_MS = 3000;
const IMAGE_COPY_BUTTON_WAIT_MS = 60_000;
const IMAGE_INITIAL_POLL_MS = 4000;
const IMAGE_QUEUE_SETTLE_MS = 650;
/** bg-gemini-flow.js — quota probe after this elapsed ms in ready poll. */
const GEMINI_IMAGE_QUOTA_CHECK_AFTER_MS = 8000;
/** bg-gemini-flow.js GEMINI_IMAGE_RESPONSE_STOPPED_CHECK_EVERY_MS */
const GEMINI_IMAGE_RESPONSE_STOPPED_CHECK_EVERY_MS = 60_000;
/** Extra 「이미지 복사」 clicks when clipboard has no image after first copy. */
const GEMINI_IMAGE_POST_COPY_RETRY_MAX = 2;
/** bg-gemini-flow.js GEMINI_IMAGE_POST_COPY_FORCE_CLOSE_DELAY_MS — read after copy. */
const GEMINI_IMAGE_POST_COPY_DELAY_MS = process.env.JA_GEMINI_IMAGE_DELAY !== undefined
  ? parseFloat(process.env.JA_GEMINI_IMAGE_DELAY) * 1000
  : 1000;
const GEMINI_IMAGE_CLIPBOARD_TAB_RETRY_MS = 800;

const { reloadGeminiPageForRetry } = require('./gemini_compose');

/** bg-gemini-flow.js GEMINI_IMAGE_FLOW_MAX_RESTARTS (= GEMINI_FLOW_RETRY_MAX). */
const GEMINI_IMAGE_FLOW_MAX_RESTARTS = GEMINI_FLOW_RETRY_MAX;
const GEMINI_IMAGE_RELOAD_MAX = GEMINI_FLOW_RETRY_MAX;

// ── 이미지 스타일 프롬프트 (prompts/gemini-image-style.txt) ─────────────────────
// 이미지 생성 요청 시 각 섹션의 imgplace 텍스트 뒤에 붙는 스타일 지시문.
// 스타일을 변경하려면 automation/prompts/gemini-image-style.txt 파일을 편집하세요.
const _IMAGE_STYLE_FILE = path.join(__dirname, 'prompts', 'gemini-image-style.txt');
const GEMINI_IMAGE_PROMPT_SUFFIX = (() => {
  if (!fs.existsSync(_IMAGE_STYLE_FILE)) {
    throw new Error(`[GeminiImage] 필수 프롬프트 파일이 없습니다: ${_IMAGE_STYLE_FILE}`);
  }
  const raw = fs.readFileSync(_IMAGE_STYLE_FILE, 'utf8');
  const body = raw.replace(/^={10,}[\s\S]*?={10,}\r?\n?/, '').trim();
  if (!body) {
    throw new Error(`[GeminiImage] 프롬프트 파일이 비어있습니다: ${_IMAGE_STYLE_FILE}`);
  }
  return body;
})();

function buildGeminiImagePrompt(imageInnerPrompt) {
  const inner = String(imageInnerPrompt || '').trim();
  if (!inner) {
    return '';
  }
  return `${inner}${GEMINI_IMAGE_PROMPT_SUFFIX}`;
}

function isLastQueueIndex(queueIndex, queueTotal) {
  return queueIndex >= queueTotal - 1;
}

function buildImageSelectorBundle() {
  return {
    legacyToolBtn: SELECTORS.image.toolBtn,
    uploadToolsBtn: SELECTORS.image.uploadToolsBtn,
    imageMenuLabel: SELECTORS.image.imageMenuLabel,
    imageMenuButton: SELECTORS.image.imageMenuButton,
    composerEditor: SELECTORS.composerEditor,
    sendBtn: SELECTORS.composerSendBtn,
    copyBtn: SELECTORS.image.copyBtn,
  };
}

/**
 * MAIN-world: upload/tools → 이미지 만들기 → prompt fill → send.
 * Port of jably_blog runGeminiImageClickToolFillSend inject func.
 * Self-contained defaults (no Node module constants — Playwright evaluate runs in browser).
 *
 * @param {{ promptText?: string, totalMs?: number, sels?: object, menuOpenMs?: number, debug?: boolean } | string} arg
 */
function geminiImageToolFillSendMain(arg) {
  const DEFAULT_TOTAL_MS = 18000;
  const DEFAULT_MENU_OPEN_MS = 1500;

  let promptText = '';
  let totalMs = DEFAULT_TOTAL_MS;
  let sels = {};
  let menuOpenMs = DEFAULT_MENU_OPEN_MS;
  let debug = false;

  if (typeof arg === 'string') {
    promptText = arg;
  } else if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
    promptText = typeof arg.promptText === 'string' ? arg.promptText : '';
    totalMs =
      typeof arg.totalMs === 'number' && arg.totalMs > 0 ? arg.totalMs : DEFAULT_TOTAL_MS;
    sels =
      arg.sels && typeof arg.sels === 'object' && !Array.isArray(arg.sels) ? arg.sels : {};
    menuOpenMs =
      typeof arg.menuOpenMs === 'number' && arg.menuOpenMs > 0
        ? arg.menuOpenMs
        : DEFAULT_MENU_OPEN_MS;
    debug = arg.debug === true;
  }

  const L = (...parts) => {
    console.log('[ja_test][GeminiImage]', ...parts);
    if (!debug) {
      return;
    }
    try {
      if (!window.__jablyGeminiImageDebug) {
        window.__jablyGeminiImageDebug = { events: [] };
      }
      window.__jablyGeminiImageDebug.events.push({
        at: Date.now(),
        parts: parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))),
      });
      if (window.__jablyGeminiImageDebug.events.length > 40) {
        window.__jablyGeminiImageDebug.events.shift();
      }
    } catch {
      /* ignore */
    }
  };

  const sleepLocal = (ms) => new Promise((r) => setTimeout(r, ms));
  const toolsMenuOpenMs =
    typeof menuOpenMs === 'number' && menuOpenMs > 0 ? menuOpenMs : DEFAULT_MENU_OPEN_MS;
  const budgetMs = typeof totalMs === 'number' && totalMs > 0 ? totalMs : DEFAULT_TOTAL_MS;
  const t0 = Date.now();
  const timeLeft = () => Math.max(0, budgetMs - (Date.now() - t0));

  function qFirst(candidates) {
    const list = Array.isArray(candidates) ? candidates : [candidates];
    for (const s of list) {
      if (!s) continue;
      const el = document.querySelector(s);
      if (el) return el;
    }
    return null;
  }

  function isVisibleClickable(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2 && !el.disabled;
  }

  function findLegacyImageToolButton() {
    const direct = qFirst(sels.legacyToolBtn);
    if (direct) return direct;
    return (
      [...document.querySelectorAll('button.card')].find((el) =>
        /이미지\s*만들기/.test(el.getAttribute('aria-label') || el.textContent || ''),
      ) || null
    );
  }

  function findUploadToolsMenuButton() {
    const direct = qFirst(sels.uploadToolsBtn);
    if (direct) return direct;
    return (
      [...document.querySelectorAll('gem-icon-button button[aria-label]')].find((el) =>
        /업로드\s*및\s*도구/i.test(el.getAttribute('aria-label') || ''),
      ) || null
    );
  }

  function findImageMakeMenuItem() {
    for (const s of sels.imageMenuLabel || []) {
      for (const lab of document.querySelectorAll(s)) {
        if (!/이미지\s*만들기/i.test((lab.textContent || '').trim())) continue;
        const btn =
          lab.closest('button') ||
          lab.closest('toolbox-drawer-item')?.querySelector('button') ||
          lab.closest('mat-action-list')?.querySelector('button');
        if (btn && isVisibleClickable(btn)) return btn;
        if (isVisibleClickable(lab)) return lab;
      }
    }
    for (const s of sels.imageMenuButton || []) {
      for (const btn of document.querySelectorAll(s)) {
        const t = (btn.innerText || btn.textContent || btn.getAttribute('aria-label') || '').trim();
        if (/이미지\s*만들기/i.test(t) && isVisibleClickable(btn)) return btn;
      }
    }
    return null;
  }

  async function clickEl(el, tag) {
    try {
      el.scrollIntoView({ block: 'center', behavior: 'auto' });
    } catch {
      /* ignore */
    }
    await sleepLocal(120);
    el.click();
    L('click', tag);
  }

  async function clickImageToolViaUploadMenu() {
    const menuBtn = findUploadToolsMenuButton();
    if (!menuBtn || !isVisibleClickable(menuBtn)) return false;
    await clickEl(menuBtn, 'upload-tools-menu');
    await sleepLocal(toolsMenuOpenMs);
    for (let i = 0; i < 24 && timeLeft() > 80; i += 1) {
      const item = findImageMakeMenuItem();
      if (item) {
        await clickEl(item, 'image-make-menu-item');
        await sleepLocal(650);
        if (pickQlEditor()) return true;
      }
      await sleepLocal(150);
    }
    return false;
  }

  async function clickLegacyImageToolButton() {
    const b = findLegacyImageToolButton();
    if (!b || !isVisibleClickable(b)) return false;
    await clickEl(b, 'legacy-image-tool');
    await sleepLocal(600);
    return !!pickQlEditor();
  }

  async function clickImageTool() {
    await sleepLocal(Math.min(800, Math.max(0, timeLeft() - 50)));
    let attempts = 0;
    while (timeLeft() > 80) {
      attempts += 1;
      if (await clickLegacyImageToolButton()) return true;
      if (findUploadToolsMenuButton() && (await clickImageToolViaUploadMenu())) return true;
      if (attempts >= 40) break;
      await sleepLocal(150);
    }
    return false;
  }

  function pickQlEditor() {
    const found = [];
    for (const s of sels.composerEditor || []) {
      document.querySelectorAll(s).forEach((el) => found.push(el));
    }
    const ok = found.filter((el) => {
      if (!el.isContentEditable) return false;
      if (el.classList.contains('ql-clipboard') || el.closest('.ql-clipboard')) return false;
      const r = el.getBoundingClientRect();
      return r.width > 2 && r.height > 2;
    });
    ok.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return rb.width * rb.height - ra.width * ra.height;
    });
    return ok[0] || null;
  }

  async function waitForQlEditor() {
    while (timeLeft() > 80) {
      const ed = pickQlEditor();
      if (ed) return ed;
      await sleepLocal(120);
    }
    return null;
  }

  async function clickSend(editor) {
    function sendLikelyStarted() {
      for (const b of document.querySelectorAll('button[aria-label], button.send-button')) {
        const lab = (b.getAttribute('aria-label') || '').trim();
        if (/중지|Stop generating|일시중지|^Stop$/i.test(lab)) {
          const r = b.getBoundingClientRect();
          if (r.width > 2 && r.height > 2) return true;
        }
      }
      const btn = qFirst(sels.sendBtn);
      if (btn && btn.getAttribute('aria-disabled') === 'true') return true;
      return false;
    }

    if (editor) {
      editor.focus();
      await sleepLocal(120);
      try {
        editor.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true,
          }),
        );
        await sleepLocal(320);
        if (sendLikelyStarted()) return true;
      } catch {
        /* ignore */
      }
    }

    for (let attempt = 0; timeLeft() > 40 && attempt < 40; attempt += 1) {
      const btn = qFirst(sels.sendBtn);
      if (btn && btn.getAttribute('aria-disabled') !== 'true') {
        const r = btn.getBoundingClientRect();
        if (r.width > 1 && r.height > 1) {
          btn.click();
          await sleepLocal(200);
          if (sendLikelyStarted()) return true;
        }
      }
      await sleepLocal(80);
    }
    return false;
  }

  return (async () => {
    L('start', { promptChars: String(promptText || '').length, budgetMs });
    const clicked = await clickImageTool();
    if (!clicked) {
      L('fail', 'no_image_tool_button');
      return { ok: false, reason: 'no_image_tool_button' };
    }
    await sleepLocal(Math.min(900, Math.max(0, timeLeft() - 50)));
    const ed = await waitForQlEditor();
    if (!ed) {
      L('fail', 'no_editor');
      return { ok: false, reason: 'no_editor' };
    }

    const t = String(promptText || '').trim();
    ed.focus();
    try {
      ed.click();
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
    } catch (e) {
      L('fill err', e);
    }

    return { ok: true, reason: 'editor_focused' };
  })();
}

function logGeminiImagePhase(logger, phase, detail) {
  const suffix =
    detail == null
      ? ''
      : typeof detail === 'string'
        ? ` — ${detail}`
        : ` — ${JSON.stringify(detail)}`;
  logger?.info?.(`[GeminiImage] ${phase}${suffix}`);
}

function probeGeminiImageGeneratedReadyMain() {
  function imgLooksReady(el) {
    if (!el || el.tagName !== 'IMG') return false;
    const nw = el.naturalWidth || 0;
    const nh = el.naturalHeight || 0;
    if (nw > 0 && nh > 0) return true;
    if (el.complete && (nw > 0 || nh > 0)) return true;
    const r = el.getBoundingClientRect?.();
    const hasSrc = !!(el.getAttribute('src') || el.getAttribute('srcset'));
    if (hasSrc && r && r.width > 12 && r.height > 12) return true;
    return false;
  }

  function copyControlVisible(oc) {
    if (!oc) return false;
    const selectors = [
      'copy-button button[aria-label="이미지 복사"]',
      'copy-button button.copy-button',
      'button.copy-button[aria-label="이미지 복사"]',
      'button[mattooltip="이미지 복사"]',
      '.generated-image-controls button.copy-button',
    ];
    for (const sel of selectors) {
      const btn = oc.querySelector(sel);
      if (!btn) continue;
      const r = btn.getBoundingClientRect();
      const al = (btn.getAttribute('aria-label') || '').trim();
      const tip = (btn.getAttribute('mattooltip') || '').trim();
      const inCopyHost = !!btn.closest('copy-button');
      const isImageCopy =
        al === '이미지 복사' ||
        tip === '이미지 복사' ||
        btn.classList.contains('copy-button') ||
        inCopyHost;
      if (isImageCopy && r.width > 2 && r.height > 2) return true;
    }
    return false;
  }

  const overlays = [...document.querySelectorAll('div.overlay-container')];
  const oc = overlays[overlays.length - 1];
  if (oc) {
    const ib = oc.querySelector('button.image-button');
    const imgInBtn = ib?.querySelector('img');
    if (imgLooksReady(imgInBtn)) return true;
    if (copyControlVisible(oc)) return true;
  }
  const legacy = document.querySelector('button.image-button img.loaded');
  return imgLooksReady(legacy);
}

function probeGeminiImageQuotaExhaustedMain() {
  const turns = document.querySelectorAll(
    "model-response, [data-test-id='model-response'], message-content",
  );
  if (!turns.length) return false;
  const last = turns[turns.length - 1];
  const txt = (last.innerText || '').trim();
  return (
    /더\s*이상\s*이미지를?\s*생성할\s*수\s*없습니다/i.test(txt) ||
    /이미지\s*생성\s*한도/i.test(txt) ||
    /can\s*(?:'t|not)\s*generate\s*(?:any\s*)?more\s*images/i.test(txt) ||
    /image\s*(?:generation\s*)?limit/i.test(txt)
  );
}

function probeGeminiImageResponseStoppedMain() {
  for (const av of document.querySelectorAll('.avatar.avatar_secondary')) {
    const mi = av.querySelector(
      'mat-icon[fonticon="error"], mat-icon[data-mat-icon-name="error"]',
    );
    if (mi) {
      const r = av.getBoundingClientRect();
      if (r.width > 2 && r.height > 2) {
        return { hit: true, reason: 'avatar_secondary_error_mat_icon' };
      }
    }
  }
  const primaries = document.querySelectorAll('.avatar.avatar_primary');
  if (primaries.length === 1) {
    const p = primaries[0];
    const pr = p.getBoundingClientRect();
    if (pr.width > 2 && pr.height > 2) {
      const orb =
        p.querySelector('.avatar_primary_animation[lottie-animation]') ||
        p.querySelector('[lottie-animation].avatar_primary_animation') ||
        p.querySelector('.avatar_primary_model [lottie-animation]') ||
        p.querySelector('lottie-animation');
      if (orb) {
        return { hit: true, reason: 'single_primary_avatar_lottie' };
      }
    }
  }
  const turns = [
    ...document.querySelectorAll(
      "model-response, [data-test-id='model-response'], message-content",
    ),
  ];
  const n = turns.length;
  const from = Math.max(0, n - 3);
  for (let i = n - 1; i >= from; i -= 1) {
    const txt = (turns[i].innerText || '').trim();
    if (
      /대답이\s*중지되었습니다/i.test(txt) ||
      /답변?\s*(?:이\s*)?중지되었습니다/i.test(txt) ||
      /response\s+(?:was\s+)?stopped/i.test(txt)
    ) {
      return { hit: true, reason: 'text_stopped' };
    }
  }
  const pendings = document.querySelectorAll('span.pending');
  for (const el of pendings) {
    const raw = (el.textContent || '').trim();
    if (/\[IMAGE\]/i.test(raw)) {
      return { hit: true, reason: 'pending_image_placeholder' };
    }
  }
  return { hit: false, reason: '' };
}

function geminiImageDomHoverMain() {
  const overlays = [...document.querySelectorAll('div.overlay-container')];
  const oc = overlays[overlays.length - 1];
  if (!oc) return false;
  try {
    oc.scrollIntoView({ block: 'center', behavior: 'auto' });
  } catch {
    /* ignore */
  }
  const view = oc.ownerDocument.defaultView;
  for (const type of ['mouseenter', 'mouseover', 'mousemove']) {
    oc.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view }));
  }
  const gic = oc.querySelector('.generated-image-controls');
  if (gic) {
    for (const type of ['mouseenter', 'mouseover', 'mousemove']) {
      gic.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view }));
    }
  }
  return true;
}

function getGeminiLastOverlayHoverPointsMain() {
  function chainToRoot(el, lx, ly) {
    let x = lx;
    let y = ly;
    let win = el?.ownerDocument?.defaultView;
    while (win && win.frameElement) {
      const fr = win.frameElement.getBoundingClientRect();
      x += fr.left;
      y += fr.top;
      win = win.parent;
    }
    return { x: Math.round(x), y: Math.round(y) };
  }

  // 1) Legacy overlays check
  const overlays = [...document.querySelectorAll('div.overlay-container')];
  const oc = overlays[overlays.length - 1];
  if (oc) {
    const rOc = oc.getBoundingClientRect();
    const overlayPt = chainToRoot(oc, rOc.left + rOc.width / 2, rOc.top + rOc.height / 2);
    const ib = oc.querySelector('button.image-button');
    const rIb = ib?.getBoundingClientRect();
    const imagePt = ib && rIb && rIb.width > 1 && rIb.height > 1
      ? chainToRoot(ib, rIb.left + rIb.width / 2, rIb.top + rIb.height / 2)
      : overlayPt;
    return { overlayPt, imagePt };
  }

  // 2) New Gemini UI fallback (find img or message card in the last chat turn)
  const turns = [...document.querySelectorAll("model-response, [data-test-id='model-response'], message-content")];
  const lastTurn = turns[turns.length - 1];
  if (lastTurn) {
    const img = lastTurn.querySelector('img, .image-wrapper, .image-container');
    if (img) {
      const r = img.getBoundingClientRect();
      const pt = chainToRoot(img, r.left + r.width / 2, r.top + r.height / 2);
      return { overlayPt: pt, imagePt: pt };
    }
    const rL = lastTurn.getBoundingClientRect();
    const ptL = chainToRoot(lastTurn, rL.left + rL.width / 2, rL.top + rL.height / 2);
    return { overlayPt: ptL, imagePt: ptL };
  }

  return null;
}

function geminiImageScrollOverlayForCopyMain() {
  const overlays = [...document.querySelectorAll('div.overlay-container')];
  const oc = overlays[overlays.length - 1];

  let targetEl = oc;
  if (!targetEl) {
    const turns = [...document.querySelectorAll("model-response, [data-test-id='model-response'], message-content")];
    targetEl = turns[turns.length - 1];
  }

  if (!targetEl) return { ok: false };

  try {
    targetEl.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
  } catch {
    /* ignore */
  }

  const selectors = [
    'copy-button button[aria-label="이미지 복사"]',
    'copy-button button.copy-button',
    'button.copy-button[aria-label="이미지 복사"]',
    'button[mattooltip="이미지 복사"]',
    '.generated-image-controls button.copy-button',
    'copy-button button',
    'button.image-button',
  ];
  for (const sel of selectors) {
    const el = targetEl.querySelector(sel);
    if (!el) continue;
    try {
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
    } catch {
      /* ignore */
    }
  }
  return { ok: true };
}

function findGeminiImageCopyButtonCenterMain() {
  const margin = 8;

  function chainXY(el, lx, ly) {
    let x = lx;
    let y = ly;
    let win = el?.ownerDocument?.defaultView;
    while (win && win.frameElement) {
      const fr = win.frameElement.getBoundingClientRect();
      x += fr.left;
      y += fr.top;
      win = win.parent;
    }
    return { x: Math.round(x), y: Math.round(y) };
  }

  function rectIntersectsViewport(r) {
    if (!r || r.width <= 2 || r.height <= 2) return false;
    const vh = window.innerHeight || 0;
    const vw = window.innerWidth || 0;
    return (
      r.bottom > margin &&
      r.top < vh - margin &&
      r.right > margin &&
      r.left < vw - margin
    );
  }

  // Restrict to explicit image copy selectors. 
  // Exclude raw 'copy-button button' or 'copy-button button.copy-button' 
  // which match text-copy buttons.
  const selectors = [
    'copy-button button[aria-label*="이미지"]',
    'button[aria-label*="이미지 복사"]',
    'button[mattooltip*="이미지 복사"]',
    'button[aria-label*="Copy image"]',
    'button[aria-label*="copy image"]',
    '.generated-image-controls button.copy-button',
    'button.image-button',
  ];

  const overlays = [...document.querySelectorAll('div.overlay-container')];
  const oc = overlays[overlays.length - 1];

  const turns = [...document.querySelectorAll("model-response, [data-test-id='model-response'], message-content")];
  const lastTurn = turns[turns.length - 1];

  let targetBtn = null;
  for (const sel of selectors) {
    // 1) Try inside the last overlay container if available
    if (oc) {
      const btn = oc.querySelector(sel);
      if (btn) {
        targetBtn = btn;
        break;
      }
    }
    // 2) Try inside the last chat turn containing the active response
    if (lastTurn) {
      const btns = [...lastTurn.querySelectorAll(sel)];
      for (const btn of btns) {
        const label = (btn.getAttribute('aria-label') || '').toLowerCase();
        const tooltip = (btn.getAttribute('mattooltip') || '').toLowerCase();
        // Guard against text copy buttons that might slip in
        if (label.includes('텍스트') || label.includes('text') || tooltip.includes('텍스트') || tooltip.includes('text')) {
          continue;
        }
        targetBtn = btn;
        break;
      }
      if (targetBtn) break;
    }
    // 3) Fallback to the last matching button in the entire document
    const all = [...document.querySelectorAll(sel)];
    for (const btn of all) {
      const label = (btn.getAttribute('aria-label') || '').toLowerCase();
      const tooltip = (btn.getAttribute('mattooltip') || '').toLowerCase();
      if (label.includes('텍스트') || label.includes('text') || tooltip.includes('텍스트') || tooltip.includes('text')) {
        continue;
      }
      targetBtn = btn;
    }
    if (targetBtn) break;
  }

  if (!targetBtn) return null;

  try {
    targetBtn.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
  } catch {
    /* ignore */
  }

  const r = targetBtn.getBoundingClientRect();
  if (!rectIntersectsViewport(r)) return null;
  const pt = chainXY(targetBtn, r.left + r.width / 2, r.top + r.height / 2);
  const vh = window.innerHeight || 0;
  if (pt.y >= margin && pt.y < vh - margin) {
    return pt;
  }
  return null;
}

function isCopyPointInPlaywrightViewport(copyPt, viewport) {
  if (!copyPt || typeof copyPt.x !== 'number' || typeof copyPt.y !== 'number') {
    return false;
  }
  const margin = 8;
  const height = viewport?.height || 0;
  const width = viewport?.width || 0;
  if (height < 1 || width < 1) {
    return copyPt.y >= margin;
  }
  return (
    copyPt.x >= margin &&
    copyPt.x < width - margin &&
    copyPt.y >= margin &&
    copyPt.y < height - margin
  );
}

async function grantClipboardPermissionsForPage(context, page, logger) {
  if (!context || !page) return;
  try {
    const origin = new URL(page.url()).origin;
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  } catch (error) {
    logger?.info(
      `clipboard permission grant skipped (${page.url().slice(0, 48)}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function readClipboardImageInPage(page, logger) {
  try {
    await page.bringToFront();
  } catch {
    /* ignore */
  }

  return page.evaluate(async () => {
    const nc = navigator.clipboard;
    if (!nc || typeof nc.read !== 'function') {
      return { ok: false, reason: 'clipboard_api_unavailable', dataUrl: '' };
    }
    try {
      const items = await nc.read();
      for (const item of items) {
        for (const type of item.types) {
          if (!type.startsWith('image/')) continue;
          const blob = await item.getType(type);
          const dataUrl = await new Promise((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => resolve(String(fr.result || ''));
            fr.onerror = () => reject(fr.error);
            fr.readAsDataURL(blob);
          });
          if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image')) {
            return { ok: true, dataUrl, bytes: blob.size || 0 };
          }
        }
      }
      return { ok: false, reason: 'no_image_clipboard_item', dataUrl: '' };
    } catch (error) {
      return { ok: false, reason: 'clipboard_read_failed', detail: String(error), dataUrl: '' };
    }
  });
}

/**
 * Read image clipboard: Gemini tab first (post-copy focus), then Tistory tab fallback.
 * @param {import('playwright').Page} geminiPage
 * @param {import('playwright').BrowserContext} context
 * @param {{ tistoryPage?: import('playwright').Page }} [options]
 */
async function readClipboardImageDataUrl(geminiPage, context, logger, options = {}) {
  const tistoryPage = options.tistoryPage || null;

  if (geminiPage) {
    await grantClipboardPermissionsForPage(context, geminiPage, logger);
    let clip = await readClipboardImageInPage(geminiPage, logger);
    if (clip?.ok && clip.dataUrl) {
      logger?.info(`[Gemini] [IMAGE_CLIPBOARD] ${JSON.stringify({ via: 'gemini_tab', bytes: clip.bytes })}`);
      return clip;
    }
    await sleep(GEMINI_IMAGE_CLIPBOARD_TAB_RETRY_MS);
    clip = await readClipboardImageInPage(geminiPage, logger);
    if (clip?.ok && clip.dataUrl) {
      logger?.info(
        `[Gemini] [IMAGE_CLIPBOARD] ${JSON.stringify({ via: 'gemini_tab_retry', bytes: clip.bytes })}`,
      );
      return clip;
    }
    logger?.info(
      `[Gemini] [IMAGE_CLIPBOARD] gemini tab miss (${clip?.reason || 'unknown'}) — trying Tistory tab`,
    );
  }

  if (tistoryPage) {
    await grantClipboardPermissionsForPage(context, tistoryPage, logger);
    const tistoryClip = await readClipboardImageInPage(tistoryPage, logger);
    if (tistoryClip?.ok && tistoryClip.dataUrl) {
      logger?.info(
        `[Gemini] [IMAGE_CLIPBOARD] ${JSON.stringify({ via: 'tistory_tab_fallback', bytes: tistoryClip.bytes })}`,
      );
      return tistoryClip;
    }
    return tistoryClip || { ok: false, reason: 'no_image_clipboard_item', dataUrl: '' };
  }

  return { ok: false, reason: 'no_clipboard_page', dataUrl: '' };
}

async function runGeminiImageToolFillSend(page, promptText, logger) {
  const sels = buildImageSelectorBundle();
  const debugEnabled = isGeminiImageDebugEnabled();
  logGeminiImagePhase(logger, 'tool_fill_send_begin', {
    promptChars: String(promptText || '').length,
    pageUrl: page.url(),
    debugEnabled,
  });

  const evaluatePayload = {
    promptText: String(promptText || ''),
    totalMs: IMAGE_TOOL_FILL_TOTAL_MS,
    sels,
    menuOpenMs: IMAGE_UPLOAD_TOOLS_MENU_OPEN_MS,
    debug: debugEnabled,
  };

  try {
    let result = await page.evaluate(geminiImageToolFillSendMain, evaluatePayload);
    if (result && typeof result.then === 'function') {
      result = await result;
    }
    
    // If the editor is focused, we use Playwright native keyboard to type and send
    if (result?.ok && result.reason === 'editor_focused') {
      await page.keyboard.insertText(String(promptText || ''));
      await page.waitForTimeout(300);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(500);
      result = { ok: true, reason: 'ok' };
    }
    
    logGeminiImagePhase(logger, 'tool_fill_send_result', result);
    if (!result?.ok) {
      await dumpGeminiImageSnapshot(page, logger, {
        label: 'tool_fill_failed',
        fillResult: result,
      });
    }
    return result || { ok: false, reason: 'no_result' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logGeminiImagePhase(logger, 'tool_fill_send_error', message);
    await dumpGeminiImageSnapshot(page, logger, {
      label: 'tool_fill_evaluate_error',
      fillResult: { ok: false, reason: 'browser_error', detail: message },
    });
    return { ok: false, reason: 'browser_error', detail: message };
  }
}

async function waitForGeminiImageReady(page, logger, timeoutMs = IMAGE_READY_POLL_MAX_MS, options = {}) {
  const deadline = Date.now() + timeoutMs;
  let nextSleep = IMAGE_INITIAL_POLL_MS;
  let lastLogAt = 0;
  const pollT0 = Date.now();
  let nextStoppedCheckDue = pollT0 + GEMINI_IMAGE_RESPONSE_STOPPED_CHECK_EVERY_MS;
  logGeminiImagePhase(logger, 'ready_poll_start', { timeoutMs, queueIndex: options.queueIndex });

  while (Date.now() < deadline) {
    if (typeof options.onPoll === 'function') {
      await options.onPoll();
    } else if (options.workflow?.touchGeminiImageFlowWatchdog) {
      options.workflow.touchGeminiImageFlowWatchdog(
        `q${options.queueIndex ?? 0}:r${options.restartCount ?? 0}`,
      );
    }

    const ready = await page.evaluate(probeGeminiImageGeneratedReadyMain);
    if (ready) {
      logGeminiImagePhase(logger, 'ready_poll_success', {
        elapsedMs: Date.now() - pollT0,
      });
      return { ok: true };
    }

    const elapsed = Date.now() - pollT0;
    if (elapsed >= GEMINI_IMAGE_QUOTA_CHECK_AFTER_MS) {
      const quotaExhausted = await page.evaluate(probeGeminiImageQuotaExhaustedMain);
      if (quotaExhausted) {
        logGeminiImagePhase(logger, 'ready_poll_quota_exhausted', { elapsedMs: elapsed });
        return { ok: false, reason: 'image_quota_exhausted', finalizePublish: true };
      }
    }

    const nowStopped = Date.now();
    if (nowStopped >= nextStoppedCheckDue) {
      nextStoppedCheckDue = nowStopped + GEMINI_IMAGE_RESPONSE_STOPPED_CHECK_EVERY_MS;
      const stopped = await page.evaluate(probeGeminiImageResponseStoppedMain);
      if (stopped?.hit) {
        logGeminiImagePhase(logger, 'ready_poll_response_stopped', stopped);
        return { ok: false, reason: 'response_stopped', detail: stopped.reason || '' };
      }
    }

    if (Date.now() - lastLogAt >= 4000) {
      logGeminiImagePhase(logger, 'ready_poll_tick', {
        remainingMs: deadline - Date.now(),
        queueIndex: options.queueIndex,
      });
      lastLogAt = Date.now();
    }

    await sleep(nextSleep);
    nextSleep = IMAGE_POLL_INTERVAL_MS;
  }

  logGeminiImagePhase(logger, 'ready_poll_timeout', { timeoutMs });
  await dumpGeminiImageSnapshot(page, logger, {
    label: 'image_ready_timeout',
    queueIndex: options.queueIndex,
    restartCount: options.restartCount,
  });
  return { ok: false, reason: 'image_ready_timeout' };
}

async function hoverAndClickGeminiImageCopy(page, logger) {
  const deadline = Date.now() + IMAGE_COPY_BUTTON_WAIT_MS;
  let attempt = 0;
  const viewport = page.viewportSize();

  while (Date.now() < deadline) {
    attempt += 1;
    await page.evaluate(geminiImageScrollOverlayForCopyMain);
    await page.evaluate(geminiImageDomHoverMain);
    const pts = await page.evaluate(getGeminiLastOverlayHoverPointsMain);
    if (pts?.overlayPt && isCopyPointInPlaywrightViewport(pts.overlayPt, viewport)) {
      await page.mouse.move(pts.overlayPt.x, pts.overlayPt.y);
      await sleep(200);
    }
    if (pts?.imagePt && isCopyPointInPlaywrightViewport(pts.imagePt, viewport)) {
      await page.mouse.move(pts.imagePt.x, pts.imagePt.y);
      await sleep(220);
    }
    await page.evaluate(geminiImageDomHoverMain);
    await sleep(380);

    const copyPt = await page.evaluate(findGeminiImageCopyButtonCenterMain);
    if (copyPt && isCopyPointInPlaywrightViewport(copyPt, viewport)) {
      logger?.info(`Gemini image copy button at (${copyPt.x}, ${copyPt.y}), attempt ${attempt}`);
      await page.mouse.move(copyPt.x, copyPt.y);
      await sleep(120);
      await page.mouse.click(copyPt.x, copyPt.y);
      await sleep(400);
      return { ok: true, copyPt };
    }
    if (copyPt && typeof copyPt.x === 'number') {
      logger?.info(
        `Gemini image copy coords out of viewport (${copyPt.x}, ${copyPt.y}) — retry after scroll/hover`,
      );
    }
    await sleep(600);
  }

  return { ok: false, reason: 'copy_button_timeout' };
}

function logGeminiImageHandoff(logger, payload) {
  const body = {
    ok: payload?.ok === true,
    bytes: payload?.bytes ?? 0,
    reason: payload?.reason ?? '',
    preview: payload?.preview ?? '',
    queueIndex: payload?.queueIndex ?? 0,
    restartCount: payload?.restartCount ?? 0,
  };
  logger?.info(`[Gemini] [IMAGE] ${JSON.stringify(body)}`);
  return body;
}

/**
 * bg-gemini-flow.js clearClipboardBetweenRounds — clear clipboard between image queue rounds.
 * @param {import('playwright').Page} page
 * @param {import('playwright').BrowserContext} context
 */
async function clearClipboardBetweenRounds(page, context, logger) {
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: 'https://gemini.google.com',
    });
  } catch (error) {
    logger?.info(
      `clipboard permission grant skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    await page.bringToFront();
  } catch {
    /* ignore */
  }

  const result = await page.evaluate(async () => {
    if (!navigator.clipboard) {
      return { ok: false, reason: 'no_clipboard_api' };
    }
    try {
      if (typeof navigator.clipboard.write === 'function') {
        const emptyPlain = new Blob([''], { type: 'text/plain' });
        await navigator.clipboard.write([new ClipboardItem({ 'text/plain': emptyPlain })]);
        return { ok: true, via: 'clipboard_item' };
      }
      if (typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText('');
        return { ok: true, via: 'writeText' };
      }
      return { ok: false, reason: 'no_write_method' };
    } catch (error) {
      try {
        if (typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText('');
          return { ok: true, via: 'writeText_fallback' };
        }
      } catch {
        /* ignore */
      }
      return { ok: false, reason: String(error) };
    }
  });

  logger?.info(`[Gemini] [CLIPBOARD_CLEAR] ${JSON.stringify(result)}`);
  return result;
}

/**
 * Full Gemini image generation: tool → fill → send → poll → hover/copy → clipboard base64.
 */
async function runGeminiImageGeneration(page, context, promptText, logger, options = {}) {
  // Clear the clipboard at the very beginning of every slot/attempt to prevent stale/legacy image leakage
  try {
    await clearClipboardBetweenRounds(page, context, logger);
  } catch (err) {
    /* ignore */
  }

  const queueIndex = typeof options.queueIndex === 'number' ? options.queueIndex : 0;
  const restartCount = typeof options.restartCount === 'number' ? options.restartCount : 0;
  const queueTotal = typeof options.queueTotal === 'number' ? options.queueTotal : 1;

  logger?.info(
    `Gemini image generation start queueIndex=${queueIndex}/${queueTotal - 1} restartCount=${restartCount}/${GEMINI_IMAGE_FLOW_MAX_RESTARTS}`,
  );

  if (!options.skipSpaWait) {
    const spaReady = await waitForGeminiSpaReady(page, 'playwright', { logger });
    if (!spaReady) {
      return { ok: false, reason: 'spa_not_ready', queueIndex, restartCount };
    }
  }

  const fillResult = await runGeminiImageToolFillSend(page, promptText, logger);
  if (!fillResult.ok) {
    const reason = fillResult.reason || 'tool_fill_failed';
    logGeminiImagePhase(logger, 'generation_abort', {
      step: 'tool_fill',
      reason,
      detail: fillResult.detail,
      queueIndex,
      restartCount,
    });
    return {
      ok: false,
      reason,
      detail: fillResult.detail,
      queueIndex,
      restartCount,
    };
  }

  const readyResult = await waitForGeminiImageReady(page, logger, options.readyTimeoutMs, {
    workflow: options.workflow,
    queueIndex: options.queueIndex,
    restartCount: options.restartCount,
    onPoll: options.onPoll,
  });
  if (!readyResult.ok) {
    return { ...readyResult, queueIndex, restartCount };
  }

  let copyResult = await hoverAndClickGeminiImageCopy(page, logger);
  if (!copyResult.ok) {
    return { ...copyResult, queueIndex, restartCount };
  }

  try {
    await page.bringToFront();
  } catch {
    /* ignore */
  }

  logger?.info(`Gemini image post-copy settle ${GEMINI_IMAGE_POST_COPY_DELAY_MS}ms (legacy parity)`);
  await sleep(GEMINI_IMAGE_POST_COPY_DELAY_MS);

  const clipOpts = { tistoryPage: options.tistoryPage || null };
  let clip = await readClipboardImageDataUrl(page, context, logger, clipOpts);
  let copyClickRetries = 0;
  while (
    (!clip?.ok || !clip.dataUrl) &&
    copyClickRetries < GEMINI_IMAGE_POST_COPY_RETRY_MAX
  ) {
    copyClickRetries += 1;
    logger?.info(
      `Gemini image clipboard miss (${clip?.reason || 'empty'}) — retry image copy ${copyClickRetries}/${GEMINI_IMAGE_POST_COPY_RETRY_MAX}`,
    );
    await sleep(600);
    copyResult = await hoverAndClickGeminiImageCopy(page, logger);
    if (!copyResult.ok) {
      break;
    }
    await sleep(GEMINI_IMAGE_POST_COPY_DELAY_MS);
    clip = await readClipboardImageDataUrl(page, context, logger, clipOpts);
  }

  if (!clip?.ok || !clip.dataUrl) {
    return {
      ok: false,
      reason: clip?.reason || 'clipboard_empty_after_copy',
      detail: clip?.detail,
      queueIndex,
      restartCount,
    };
  }

  logGeminiImageHandoff(logger, {
    ok: true,
    bytes: clip.bytes,
    preview: String(clip.dataUrl).slice(0, 48),
    queueIndex,
    restartCount,
  });

  return {
    ok: true,
    dataUrl: clip.dataUrl,
    bytes: clip.bytes,
    queueIndex,
    restartCount,
  };
}

/**
 * Retry Gemini image generation for one queue slot (bg-gemini-flow.js restartCount / max restarts).
 */
async function runGeminiImageGenerationWithRestarts(page, context, promptText, logger, options = {}) {
  const queueIndex = typeof options.queueIndex === 'number' ? options.queueIndex : 0;
  const queueTotal = typeof options.queueTotal === 'number' ? options.queueTotal : 1;
  let restartCount = typeof options.restartCount === 'number' ? options.restartCount : 0;
  let lastResult = { ok: false, reason: 'no_attempt', queueIndex, restartCount };

  while (restartCount <= GEMINI_IMAGE_FLOW_MAX_RESTARTS) {
    lastResult = await runGeminiImageGeneration(page, context, promptText, logger, {
      ...options,
      queueIndex,
      queueTotal,
      restartCount,
      skipSpaWait: restartCount > 0 ? false : options.skipSpaWait,
    });

    if (lastResult.ok) {
      return lastResult;
    }

    if (lastResult.finalizePublish) {
      logger?.info(
        `Gemini image queueIndex=${queueIndex} terminal (${lastResult.reason}) — text-only publish path`,
      );
      return { ...lastResult, terminalFailure: true };
    }

    if (restartCount >= GEMINI_IMAGE_FLOW_MAX_RESTARTS) {
      logger?.info(
        `Gemini image queueIndex=${queueIndex} exhausted restarts (${restartCount}/${GEMINI_IMAGE_FLOW_MAX_RESTARTS}): ${lastResult.reason}`,
      );
      return { ...lastResult, terminalFailure: true };
    }

    restartCount += 1;
    logger?.info(
      `Gemini image queueIndex=${queueIndex} restart ${restartCount}/${GEMINI_IMAGE_FLOW_MAX_RESTARTS} after ${lastResult.reason}`,
    );
    await clearClipboardBetweenRounds(page, context, logger);
    const geminiAppUrl =
      String(options.geminiAppUrl || 'https://gemini.google.com/app?hl=ko').trim() ||
      'https://gemini.google.com/app?hl=ko';
    try {
      logger?.info('Gemini image restart: navigate home (avoid same-chat reload)');
      await reloadGeminiPageForRetry(page, 'navigate', geminiAppUrl, 'playwright', logger);
      await sleep(2000);
    } catch (error) {
      logger?.info(
        `Gemini image restart navigate skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return lastResult;
}

module.exports = {
  IMAGE_TOOL_FILL_TOTAL_MS,
  IMAGE_READY_POLL_MAX_MS,
  IMAGE_COPY_BUTTON_WAIT_MS,
  IMAGE_QUEUE_SETTLE_MS,
  GEMINI_IMAGE_POST_COPY_DELAY_MS,
  GEMINI_IMAGE_FLOW_MAX_RESTARTS,
  GEMINI_IMAGE_RELOAD_MAX,
  buildGeminiImagePrompt,
  isLastQueueIndex,
  buildImageSelectorBundle,
  geminiImageToolFillSendMain,
  probeGeminiImageGeneratedReadyMain,
  probeGeminiImageQuotaExhaustedMain,
  probeGeminiImageResponseStoppedMain,
  runGeminiImageToolFillSend,
  waitForGeminiImageReady,
  hoverAndClickGeminiImageCopy,
  readClipboardImageDataUrl,
  clearClipboardBetweenRounds,
  runGeminiImageGeneration,
  runGeminiImageGenerationWithRestarts,
  logGeminiImageHandoff,
  logGeminiImagePhase,
};
