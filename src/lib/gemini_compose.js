'use strict';

/**
 * @file gemini_compose.js
 * @description Gemini 작문(Compose) 자동화 — 글 입력 및 응답 수집
 * @purpose  Gemini 웹 UI에 프롬프트를 입력하고, 생성 완료 후 HTML/JSON 응답을
 *           파싱하여 반환하는 핵심 자동화 모듈.
 * @exports  tryFillGeminiComposer, waitForGeminiResponse, runGeminiCompose
 * @seeAlso  gemini_common.js, playwright_gemini_compose.js
 */


const { sleep } = require('./common');
const {
  isGeminiComposeDebugEnabled,
  dumpGeminiComposePage,
} = require('./_legacy/gemini_compose_debug');
const {
  SELECTORS,
  GENERATING_LABEL_PATTERN,
  COPY_WAIT_MS,
  COPY_STALL_MS,
  COMPOSE_TIMEOUT_MS,
  GEMINI_FLOW_PULSE_VISIBLE_MS,
  queryFirst,
  waitForGeminiSpaReady,
  isGeminiStillGenerating,
  isGeminiStillGeneratingInPage,
} = require('./gemini_common');
const { looksLikeGeminiAppUiHtml } = require('./gemini_validate');

const COPY_POLL_MS = 300;
const SEND_BUTTON_POLL_MS = 50;
const SEND_BUTTON_MAX_ATTEMPTS = 40;
const COPY_SETTLE_MS = 400;
const DEFAULT_GEMINI_APP_URL = 'https://gemini.google.com/app?hl=ko';

/** Playwright-only locators — pierce shadow DOM; aligned with hasActivePrompt in playwright_gemini_test.js */
const PLAYWRIGHT_COMPOSER_EXTRA = [
  '[data-test-id="prompt-textarea"]',
  '[data-test-id="prompt-textarea"] div.ql-editor',
  'rich-textarea.text-input-field_textarea',
  'rich-textarea div.ql-editor[role="textbox"]',
  'rich-textarea div.ql-editor',
  'rich-textarea',
  '[aria-label*="prompt" i][contenteditable="true"]',
  '[aria-label*="입력" i][contenteditable="true"]',
  '[contenteditable="true"][role="textbox"]',
];

function composerLocatorSelectors() {
  const seen = new Set();
  const out = [];
  for (const selector of [...SELECTORS.composerEditor, ...PLAYWRIGHT_COMPOSER_EXTRA]) {
    const trimmed = String(selector || '').trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normalizeComposerText(text) {
  return String(text || '')
    .replace(/\u200b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function verifyComposerFillText(got, want) {
  const gotN = normalizeComposerText(got);
  const wantN = normalizeComposerText(want);
  if (!wantN) {
    return false;
  }
  if (gotN.includes(wantN)) {
    return true;
  }
  const headLen = Math.min(120, wantN.length);
  if (headLen >= 20 && gotN.includes(wantN.slice(0, headLen))) {
    return true;
  }
  return gotN.length >= Math.min(200, wantN.length * 0.4) && gotN.length >= 20;
}

async function isComposerLocatorUsable(locator) {
  try {
    if ((await locator.count()) === 0) {
      return false;
    }
    const target = locator.first();
    if (!(await target.isVisible({ timeout: 800 }))) {
      return false;
    }
    const box = await target.boundingBox();
    if (!box || box.width < 3 || box.height < 3) {
      return false;
    }
    const isClipboard = await target
      .evaluate((el) => el.classList?.contains('ql-clipboard') || !!el.closest?.('.ql-clipboard'))
      .catch(() => false);
    return !isClipboard;
  } catch {
    return false;
  }
}

async function ensureGeminiAppPage(page, geminiUrl, logger) {
  const target = String(geminiUrl || DEFAULT_GEMINI_APP_URL).trim() || DEFAULT_GEMINI_APP_URL;
  const appUrl = /\/app/i.test(target) ? target : DEFAULT_GEMINI_APP_URL;
  const current = page.url();

  if (!/gemini\.google\.com/i.test(current) || !/\/app/i.test(current) || /\/library/i.test(current)) {
    logger?.info?.(`Ensuring Gemini /app URL (was: ${current}) → ${appUrl}`);
    await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await sleep(4000);
    logger?.info?.(`Gemini URL after ensure: ${page.url()}`);
  }
}

function normalizeEngine(engine) {
  const value = String(engine || 'playwright').toLowerCase();
  return value === 'selenium' ? 'selenium' : 'playwright';
}

function normalizeText(text) {
  return String(text || '')
    .replace(/\u200b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** In-page: pick largest visible ql-editor (tryFillGeminiComposer pick()). */
function pickComposerEditorInPage(composerSelectors) {
  const found = [];
  for (const selector of composerSelectors || []) {
    try {
      document.querySelectorAll(selector).forEach((el) => found.push(el));
    } catch {
      /* ignore */
    }
  }

  const candidates = found.filter((el) => {
    if (!el.isContentEditable) {
      return false;
    }
    if (el.classList.contains('ql-clipboard') || el.closest('.ql-clipboard')) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  });

  candidates.sort((a, b) => {
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    return rb.width * rb.height - ra.width * ra.height;
  });

  return candidates[0] || null;
}

/** Serializable probe for Playwright frame.evaluate (DOM nodes cannot cross the boundary). */
function hasComposerEditorInPage(arg) {
  const composerSelectors = Array.isArray(arg) ? arg : arg?.composerSelectors;
  return pickComposerEditorInPage(composerSelectors) != null;
}

function listGeminiCopyButtonsInPage() {
  const out = [];
  for (const button of document.querySelectorAll('button')) {
    const testId = button.getAttribute('data-test-id');
    const aria = (button.getAttribute('aria-label') || '').trim();
    const tooltip = (button.getAttribute('mattooltip') || '').trim();
    const copyClass = button.classList.contains('copy-button');
    const match =
      testId === 'copy-button' ||
      copyClass ||
      aria === '대답 복사' ||
      aria === '답변 복사' ||
      tooltip === '대답 복사' ||
      tooltip === '답변 복사';
    if (!match) {
      continue;
    }
    // Exclude code block copy buttons
    const combined = (aria + ' ' + tooltip).toLowerCase();
    if (combined.includes('코드') || combined.includes('code')) {
      continue;
    }
    out.push(button);
  }
  return out;
}

function pickGeminiCopyTargetInPage(buttons) {
  if (!buttons.length) {
    return null;
  }
  const byTooltip = (tip) =>
    buttons.find((b) => (b.getAttribute('mattooltip') || '').trim() === tip);
  const byAria = (label) =>
    buttons.find((b) => (b.getAttribute('aria-label') || '').trim() === label);
  const byTestId = buttons.find((b) => b.getAttribute('data-test-id') === 'copy-button');
  const full =
    byTooltip('대답 복사') ||
    byTooltip('답변 복사') ||
    byAria('대답 복사') ||
    byAria('답변 복사') ||
    byTestId;
  if (full) {
    return full;
  }
  return buttons[buttons.length - 1];
}

function extractGeminiReplyFromCopyButtonContextInPage(button) {
  if (!button?.closest) {
    return '';
  }
  const responseSelectors = [
    '[data-test-id="model-response"]',
    '[data-test-id="message-content"]',
    'model-response',
    '.model-response-text',
    'message-content',
  ];
  for (const selector of responseSelectors) {
    try {
      const root = button.closest(selector);
      if (root) {
        const text = (root.innerText || '').replace(/\u200b/g, '').trim();
        if (text.length >= 10) {
          return text;
        }
      }
    } catch {
      /* ignore */
    }
  }

  const footer =
    button.closest('message-actions') ||
    button.closest("[class*='message-footer']") ||
    button.closest("[class*='response-footer']");
  const parent = footer?.parentElement;
  if (parent) {
    const children = Array.from(parent.children);
    const idx = children.findIndex((c) => c.contains(button));
    for (let j = idx - 1; j >= 0; j -= 1) {
      const text = (children[j].innerText || '').replace(/\u200b/g, '').trim();
      if (text.length >= 20) {
        return text;
      }
    }
    const whole = (parent.innerText || '').replace(/\u200b/g, '').trim();
    if (whole.length >= 20) {
      return whole;
    }
  }

  let el = button;
  let best = '';
  for (let depth = 0; depth < 28; depth += 1) {
    el = el.parentElement;
    if (!el || el === document.body || el === document.documentElement) {
      break;
    }
    const text = (el.innerText || '').replace(/\u200b/g, '').trim();
    if (text.length > best.length && text.length <= 400000) {
      best = text;
    }
  }
  return best;
}

function copyButtonViewportCenterToRootInPage(button) {
  const rect = button.getBoundingClientRect();
  let x = rect.left + rect.width / 2;
  let y = rect.top + rect.height / 2;
  let win = button.ownerDocument.defaultView;
  while (win && win.frameElement) {
    const fr = win.frameElement.getBoundingClientRect();
    x += fr.left;
    y += fr.top;
    win = win.parent;
  }
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: rect.width,
    height: rect.height,
  };
}

function copyButtonViewportCenterInPage(button) {
  return copyButtonViewportCenterToRootInPage(button);
}

function fillComposerInPage(arg1, arg2) {
  let text;
  let composerSelectors;
  if (arg1 && typeof arg1 === 'object' && !Array.isArray(arg1) && 'text' in arg1) {
    text = arg1.text;
    composerSelectors = arg1.composerSelectors;
  } else {
    text = arg1;
    composerSelectors = arg2;
  }

  const editor = pickComposerEditorInPage(composerSelectors);
  if (!editor) {
    return { ok: false, reason: 'no_editor' };
  }

  const want = String(text).trim();
  editor.focus();
  try {
    editor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  } catch {
    /* ignore */
  }

  function fillQuillEditorMultiline(fullText) {
    const raw = String(fullText);
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      document.execCommand('insertText', false, lines[i]);
      if (i < lines.length - 1) {
        document.execCommand('insertParagraph', false, null);
      }
    }
  }

  const tries = [
    () => fillQuillEditorMultiline(text),
    () => fillQuillEditorMultiline(text),
    () => {
      const escaped = String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      editor.innerHTML = `<p>${escaped}</p>`;
      editor.dispatchEvent(
        new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }),
      );
    },
  ];

  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const wantNorm = norm(want);

  for (let i = 0; i < tries.length; i += 1) {
    try {
      tries[i]();
    } catch {
      /* try next strategy */
    }
    const got = (editor.innerText || '').replace(/\u200b/g, '').trim();
    if (norm(got).includes(wantNorm)) {
      return { ok: true, via: i, sample: got.slice(0, 100) };
    }
  }

  return {
    ok: false,
    reason: 'verify_fail',
    sample: (editor.innerText || '').replace(/\u200b/g, '').slice(0, 120),
  };
}

function clickSendInPage(arg1, arg2) {
  let composerSelectors;
  let sendSelectors;
  if (arg1 && typeof arg1 === 'object' && !Array.isArray(arg1) && 'composerSelectors' in arg1) {
    composerSelectors = arg1.composerSelectors;
    sendSelectors = arg1.sendSelectors;
  } else {
    composerSelectors = arg1;
    sendSelectors = arg2;
  }

  const editor = pickComposerEditorInPage(composerSelectors);
  if (editor) {
    try {
      editor.focus();
      const evOpts = {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      };
      editor.dispatchEvent(new KeyboardEvent('keydown', evOpts));
      editor.dispatchEvent(new KeyboardEvent('keypress', evOpts));
      editor.dispatchEvent(new KeyboardEvent('keyup', evOpts));
      return { ok: true, sendVia: 'enter_key' };
    } catch {
      /* fall through to button */
    }
  }

  for (let attempt = 0; attempt < SEND_BUTTON_MAX_ATTEMPTS; attempt += 1) {
    let button = null;
    for (const selector of sendSelectors || []) {
      button = document.querySelector(selector);
      if (button) {
        break;
      }
    }
    if (!button) {
      button = document.querySelector('button.send-button');
    }
    if (button) {
      if (button.getAttribute('aria-disabled') === 'true') {
        continue;
      }
      const rect = button.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) {
        continue;
      }
      try {
        button.focus();
        button.click();
      } catch {
        /* ignore */
      }
      return { ok: true, sendVia: 'button_click' };
    }
  }

  return { ok: false, reason: 'no_or_disabled_send_button' };
}

function copyButtonLocatorSelectors() {
  const seen = new Set();
  const out = [];
  for (const selector of [
    ...(SELECTORS.responseCopyBtn || []),
    'button[aria-label="대답 복사"]',
    'button[mattooltip="대답 복사"]',
    'button[aria-label="답변 복사"]',
    'button[mattooltip="답변 복사"]',
  ]) {
    const trimmed = String(selector || '').trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

async function isGeneratingViaLocators(page) {
  for (const frame of page.frames()) {
    try {
      const buttons = frame.locator('button[aria-label], button[mattooltip]');
      const count = await buttons.count();
      for (let i = 0; i < count && i < 80; i += 1) {
        const button = buttons.nth(i);
        if (!(await button.isVisible({ timeout: 200 }).catch(() => false))) {
          continue;
        }
        const label = [
          await button.getAttribute('aria-label').catch(() => ''),
          await button.getAttribute('mattooltip').catch(() => ''),
        ]
          .filter(Boolean)
          .join(' ');
        if (GENERATING_LABEL_PATTERN.test(label)) {
          const box = await button.boundingBox().catch(() => null);
          if (box && box.width > 2 && box.height > 2) {
            return true;
          }
        }
      }
    } catch {
      /* try next frame */
    }
  }
  return false;
}

async function collectVisibleCopyButtons(page) {
  const found = [];
  for (const frame of page.frames()) {
    for (const selector of copyButtonLocatorSelectors()) {
      try {
        const buttons = frame.locator(selector);
        const count = await buttons.count();
        for (let i = 0; i < count; i += 1) {
          const button = buttons.nth(i);
          if (!(await button.isVisible({ timeout: 300 }).catch(() => false))) {
            continue;
          }
          const disabled = await button.getAttribute('aria-disabled').catch(() => null);
          if (disabled === 'true') {
            continue;
          }
          const box = await button.boundingBox().catch(() => null);
          if (!box || box.width < 1 || box.height < 1) {
            continue;
          }
          found.push({ frame, button, box, selector });
        }
      } catch {
        /* try next selector */
      }
    }
  }
  return found;
}

async function pickBestCopyButtonEntryAsync(entries) {
  if (!entries.length) {
    return null;
  }
  const validEntries = [];
  for (const entry of entries) {
    const tip = String((await entry.button.getAttribute('mattooltip').catch(() => '')) || '').trim();
    const aria = String((await entry.button.getAttribute('aria-label').catch(() => '')) || '').trim();
    const combined = (tip + ' ' + aria).toLowerCase();
    
    // Ignore code block copy buttons
    if (combined.includes('코드') || combined.includes('code')) {
      continue;
    }
    validEntries.push(entry);

    if (combined.includes('대답') || combined.includes('답변') || combined === 'copy') {
      return entry; // Immediate short-circuit for exact semantic match
    }
  }
  
  if (!validEntries.length) {
    return entries[entries.length - 1];
  }
  
  const byTestId = validEntries.find((entry) => entry.selector.includes('copy-button'));
  return byTestId || validEntries[validEntries.length - 1];
}

async function extractReplyFromCopyButtonLocator(button) {
  // Scroll the response container to the bottom first so Gemini lazy-renders
  // the full content (including hashtags at the end) into the DOM.
  try {
    await button.evaluate((btn) => {
      const responseSelectors = [
        '[data-test-id="model-response"]',
        '[data-test-id="message-content"]',
        'model-response',
        '.model-response-text',
        'message-content',
      ];
      let root = null;
      for (const sel of responseSelectors) {
        try {
          root = btn.closest(sel);
          if (root) break;
        } catch { /* ignore */ }
      }
      const scrollTarget = root || btn.closest('message-actions')?.parentElement || document.documentElement;
      if (scrollTarget) {
        try {
          scrollTarget.scrollIntoView({ block: 'end', behavior: 'instant' });
        } catch { /* ignore */ }
      }
      window.scrollTo(0, document.body.scrollHeight);
    });
  } catch { /* ignore */ }

  return button.evaluate((btn) => {
    function clean(text) {
      return String(text || '')
        .replace(/\u200b/g, '')
        .trim();
    }

    const responseSelectors = [
      '[data-test-id="model-response"]',
      '[data-test-id="message-content"]',
      'model-response',
      '.model-response-text',
      'message-content',
    ];
    for (const selector of responseSelectors) {
      try {
        const root = btn.closest(selector);
        if (root) {
          const text = clean(root.innerText);
          if (text.length >= 10) {
            return text;
          }
        }
      } catch {
        /* ignore */
      }
    }

    const footer =
      btn.closest('message-actions') ||
      btn.closest("[class*='message-footer']") ||
      btn.closest("[class*='response-footer']");
    const parent = footer?.parentElement;
    if (parent) {
      const children = Array.from(parent.children);
      const idx = children.findIndex((child) => child.contains(btn));
      for (let j = idx - 1; j >= 0; j -= 1) {
        const text = clean(children[j].innerText);
        if (text.length >= 20) {
          return text;
        }
      }
      const whole = clean(parent.innerText);
      if (whole.length >= 20) {
        return whole;
      }
    }

    let el = btn;
    let best = '';
    for (let depth = 0; depth < 28; depth += 1) {
      el = el.parentElement;
      if (!el || el === document.body || el === document.documentElement) {
        break;
      }
      const text = clean(el.innerText);
      if (text.length > best.length && text.length <= 400000) {
        best = text;
      }
    }
    return best;
  });
}

async function extractLatestModelResponseViaLocators(page) {
  let best = '';
  for (const frame of page.frames()) {
    for (const selector of SELECTORS.responseContainer || []) {
      try {
        const responses = frame.locator(selector);
        const count = await responses.count();
        for (let i = 0; i < count; i += 1) {
          const response = responses.nth(i);
          if (!(await response.isVisible({ timeout: 300 }).catch(() => false))) {
            continue;
          }
          const text = ((await response.innerText()) || '').replace(/\u200b/g, '').trim();
          if (text.length > best.length) {
            best = text;
          }
        }
      } catch {
        /* ignore */
      }
    }
  }
  return best;
}

async function getCopyPollStateViaLocators(page, initialCopyCount) {
  const buttons = await collectVisibleCopyButtons(page);
  const copyCount = buttons.length;
  const generating = await isGeneratingViaLocators(page);
  const candidate = await pickBestCopyButtonEntryAsync(buttons);
  let geminiReplyText = '';
  let center = null;

  if (candidate) {
    geminiReplyText = await extractReplyFromCopyButtonLocator(candidate.button);
    center = {
      x: Math.round(candidate.box.x + candidate.box.width / 2),
      y: Math.round(candidate.box.y + candidate.box.height / 2),
      width: candidate.box.width,
      height: candidate.box.height,
    };
  }

  if (!geminiReplyText || geminiReplyText.length < 20) {
    const responseText = await extractLatestModelResponseViaLocators(page);
    if (responseText.length > geminiReplyText.length) {
      geminiReplyText = responseText;
    }
  }

  const usable = !!candidate;
  let ready = copyCount > initialCopyCount && !generating && usable;

  if (!ready && !generating && geminiReplyText.length >= 200) {
    ready = true;
  }

  return {
    copyCount,
    generating,
    ready,
    usable,
    geminiReplyText,
    center,
    copyLocator: candidate?.button || null,
    copyReason: geminiReplyText ? 'dom_ready' : usable ? 'copy_button_ready' : '',
  };
}

async function getInitialCopyCountViaLocators(page) {
  const buttons = await collectVisibleCopyButtons(page);
  return buttons.length;
}

async function clickSendViaPlaywrightLocator(frame, logger) {
  const page = frame.page();

  for (let attempt = 0; attempt < SEND_BUTTON_MAX_ATTEMPTS; attempt += 1) {
    for (const selector of SELECTORS.composerSendBtn) {
      try {
        const buttons = frame.locator(selector);
        const count = await buttons.count();
        for (let i = 0; i < count; i += 1) {
          const button = buttons.nth(i);
          const disabled = await button.getAttribute('aria-disabled');
          if (disabled === 'true') {
            continue;
          }
          const box = await button.boundingBox();
          if (!box || box.width < 1 || box.height < 1) {
            continue;
          }
          await button.scrollIntoViewIfNeeded();
          await button.click({ timeout: 5000 });
          logger?.info?.(`Prompt sent via Playwright locator (${selector}).`);
          return { ok: true, sendVia: 'playwright_locator' };
        }
      } catch (error) {
        logger?.info?.(
          `Playwright send click failed (${selector}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    await sleep(SEND_BUTTON_POLL_MS);
  }

  for (const selector of composerLocatorSelectors()) {
    try {
      const editor = frame.locator(selector).first();
      if (!(await isComposerLocatorUsable(editor))) {
        continue;
      }
      await editor.click({ timeout: 3000 });
      await sleep(80);
      await page.keyboard.press('Enter');
      logger?.info?.(`Prompt sent via Enter on editor (${selector}).`);
      return { ok: true, sendVia: 'enter_key_editor' };
    } catch {
      /* try next editor selector */
    }
  }

  return { ok: false, reason: 'no_or_disabled_send_button' };
}

async function clickSendOnAnyFrame(page, engine, logger, preferredFrame = null) {
  const frames = preferredFrame ? [preferredFrame, ...page.frames()] : page.frames();
  const seen = new Set();

  for (const frame of frames) {
    const key = frame.url();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const inPage = await evaluateOnFrame(frame, clickSendInPage, {
      composerSelectors: SELECTORS.composerEditor,
      sendSelectors: SELECTORS.composerSendBtn,
    }).catch((error) => ({
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    }));
    if (inPage?.ok) {
      logger?.info(`Prompt sent via ${inPage.sendVia || 'unknown'} (frame=${frame.url().slice(0, 80)}).`);
      return inPage;
    }

    const locatorResult = await clickSendViaPlaywrightLocator(frame, logger);
    if (locatorResult?.ok) {
      return locatorResult;
    }
  }

  return { ok: false, reason: 'no_or_disabled_send_button' };
}

function getCopyPollStateInPage(arg1, arg2, arg3) {
  let initialCopyCount;
  let labelPatternSource;
  let generatingIndicatorSelectors;
  if (arg1 && typeof arg1 === 'object' && !Array.isArray(arg1) && 'initialCopyCount' in arg1) {
    ({
      initialCopyCount,
      labelPatternSource,
      generatingIndicatorSelectors,
    } = arg1);
  } else {
    initialCopyCount = arg1;
    labelPatternSource = arg2;
    generatingIndicatorSelectors = arg3;
  }

  const labelPattern = new RegExp(labelPatternSource);
  const buttons = listGeminiCopyButtonsInPage();
  const copyCount = buttons.length;

  let generating = false;
  const indicatorSelector =
    (generatingIndicatorSelectors || []).join(', ') ||
    'button[aria-label], [mat-button][aria-label], button[mattooltip]';
  const nodes = document.querySelectorAll(indicatorSelector);
  for (const el of nodes) {
    const label = [
      el.getAttribute('aria-label'),
      el.getAttribute('mattooltip'),
      el.getAttribute('data-tooltip'),
    ]
      .filter(Boolean)
      .join(' ');
    if (labelPattern.test(label)) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 2 && rect.height > 2) {
        generating = true;
        break;
      }
    }
  }

  const candidate = pickGeminiCopyTargetInPage(buttons);
  const rect = candidate?.getBoundingClientRect();
  const usable =
    candidate &&
    rect &&
    rect.width > 1 &&
    rect.height > 1 &&
    candidate.getAttribute('aria-disabled') !== 'true' &&
    !candidate.disabled;

  const geminiReplyText = usable ? extractGeminiReplyFromCopyButtonContextInPage(candidate) : '';
  const center = usable ? copyButtonViewportCenterInPage(candidate) : null;

  return {
    copyCount,
    generating,
    ready: copyCount > initialCopyCount && !generating && usable,
    usable,
    geminiReplyText,
    center,
  };
}

function getInitialCopyCountInPage() {
  return listGeminiCopyButtonsInPage().length;
}

async function focusGeminiFlowPage(page, engine, logger) {
  if (normalizeEngine(engine) === 'selenium') {
    try {
      await page.executeScript('window.focus();');
    } catch {
      /* ignore */
    }
    await sleep(120);
    await sleep(220);
    return;
  }

  try {
    await page.bringToFront();
  } catch (error) {
    logger?.info(
      `bringToFront skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  await sleep(120);

  try {
    const client = await page.context().newCDPSession(page);
    await client.send('Page.bringToFront');
    await client.detach();
  } catch {
    /* CDP bringToFront is best-effort on Windows */
  }
  await sleep(220);
}

/**
 * bg-gemini-flow.js debuggerDispatchMouseClick — trusted click for Gemini copy button.
 */
async function dispatchCdpMouseClick(page, x, y, logger) {
  const client = await page.context().newCDPSession(page);
  try {
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'none',
    });
    await client.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
    await sleep(60);
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
    logger?.info(`CDP copy click dispatched at (${x}, ${y}).`);
    return { ok: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger?.info(`CDP click failed: ${detail}`);
    return { ok: false, reason: detail };
  } finally {
    try {
      await client.detach();
    } catch {
      /* ignore */
    }
  }
}

/**
 * bg-gemini-flow.js reloadGeminiTabForRetry parity.
 * @param {'navigate'|'reload'} mode
 */
async function reloadGeminiPageForRetry(page, mode, url, engine, logger) {
  const geminiUrl = String(url || 'https://gemini.google.com/app?hl=ko').trim();

  if (normalizeEngine(engine) === 'selenium') {
    if (mode === 'navigate') {
      await page.get(geminiUrl);
      await sleep(4000);
    } else {
      await page.navigate().refresh();
      await sleep(5000);
    }
    logger?.info(`Gemini tab retry ${mode} complete (selenium).`);
    return;
  }

  if (mode === 'navigate') {
    await page.goto(geminiUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await sleep(4000);
  } else {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
    await sleep(5000);
  }
  await ensureGeminiAppPage(page, geminiUrl, logger);
  logger?.info(`Gemini tab retry ${mode} complete.`);
}

async function evaluateInPage(page, engine, fn, ...args) {
  if (normalizeEngine(engine) === 'selenium') {
    const script = `
      const fn = ${fn.toString()};
      return fn.apply(null, arguments);
    `;
    return page.executeScript(script, ...args);
  }

  const frame = typeof page.mainFrame === 'function' ? page.mainFrame() : page;
  if (args.length === 0) {
    return frame.evaluate(fn);
  }
  if (args.length === 1) {
    return frame.evaluate(fn, args[0]);
  }
  throw new Error(
    'Playwright frame.evaluate accepts at most one argument; wrap extras in an object payload.',
  );
}

/**
 * Playwright-safe frame.evaluate — always passes a single serializable payload.
 */
async function evaluateOnFrame(frame, fn, payload = undefined) {
  if (payload === undefined) {
    return frame.evaluate(fn);
  }
  return frame.evaluate(fn, payload);
}

/**
 * Legacy tryFillGeminiComposer chrome.scripting allFrames:true parity.
 * Runs fn in each Playwright frame; returns first result with ok===true.
 */
async function evaluateFirstOkInAllFrames(page, engine, fn, payload) {
  if (normalizeEngine(engine) === 'selenium') {
    return evaluateInPage(page, engine, fn, payload);
  }

  const frames = page.frames();
  let lastFailure = null;
  for (let i = 0; i < frames.length; i += 1) {
    const frame = frames[i];
    try {
      const result = await evaluateOnFrame(frame, fn, payload);
      if (result?.ok === true) {
        return { ...result, _frameIndex: i, _frameUrl: frame.url() };
      }
      if (result && typeof result === 'object') {
        lastFailure = { ...result, _frameIndex: i, _frameUrl: frame.url() };
      }
    } catch {
      /* try next frame */
    }
  }

  return (
    lastFailure || {
      ok: false,
      reason: 'no_editor',
      framesTried: frames.length,
    }
  );
}

/**
 * Pick the best copy-poll state across frames (ready first, else highest copyCount).
 */
async function evaluateCopyStateInAllFrames(page, engine, fn, payload) {
  if (normalizeEngine(engine) === 'selenium') {
    return evaluateInPage(page, engine, fn, payload);
  }

  const frames = page.frames();
  let best = null;
  for (const frame of frames) {
    try {
      const state = await evaluateOnFrame(frame, fn, payload);
      if (!state || typeof state !== 'object') {
        continue;
      }
      if (state.ready) {
        return state;
      }
      if (!best || (state.copyCount || 0) > (best.copyCount || 0)) {
        best = state;
      }
    } catch {
      /* try next frame */
    }
  }

  return (
    best || {
      copyCount: 0,
      generating: false,
      ready: false,
      usable: false,
      geminiReplyText: '',
      center: null,
    }
  );
}

async function isGeneratingInAnyFrame(page, engine) {
  if (normalizeEngine(engine) === 'selenium') {
    return isGeminiStillGenerating(page, engine);
  }

  for (const frame of page.frames()) {
    try {
      const generating = await evaluateOnFrame(frame, isGeminiStillGeneratingInPage, {
        indicatorSelectors: SELECTORS.generatingIndicators,
        labelPatternSource: GENERATING_LABEL_PATTERN.source,
      });
      if (generating) {
        return true;
      }
    } catch {
      /* try next frame */
    }
  }
  return false;
}

/** @typedef {import('playwright').Frame} PlaywrightFrame */

/**
 * Resolve the frame that hosts the Gemini composer.
 * Playwright locators pierce shadow DOM; in-page querySelector is a secondary pass.
 * @returns {Promise<PlaywrightFrame|null>}
 */
async function resolveComposerFrame(page, engine, logger) {
  if (normalizeEngine(engine) === 'selenium') {
    const editor = await queryFirst(page, SELECTORS.composerEditor, engine);
    return editor ? page : null;
  }

  const frames = page.frames();
  const selectors = composerLocatorSelectors();

  for (let i = 0; i < frames.length; i += 1) {
    const frame = frames[i];
    for (const selector of selectors) {
      try {
        const locator = frame.locator(selector);
        if (!(await isComposerLocatorUsable(locator))) {
          continue;
        }
        logger?.info?.(
          `Composer editor found via Playwright locator in frame ${i} (${selector}, ${frame.url().slice(0, 80)}).`,
        );
        return frame;
      } catch {
        /* try next selector */
      }
    }
  }

  for (let i = 0; i < frames.length; i += 1) {
    const frame = frames[i];
    try {
      const hasEditor = await evaluateOnFrame(frame, hasComposerEditorInPage, {
        composerSelectors: SELECTORS.composerEditor,
      });
      if (hasEditor) {
        logger?.info?.(`Composer editor found via in-page query in frame ${i} (${frame.url().slice(0, 80)}).`);
        return frame;
      }
    } catch {
      /* try next frame */
    }
  }

  logger?.info?.(
    `Composer editor not found in any of ${frames.length} frame(s) (locator + in-page). Will attempt locator fill on all frames.`,
  );
  return null;
}

async function resolveComposerFrameForFill(page, engine, logger) {
  const resolved = await resolveComposerFrame(page, engine, logger);
  if (resolved) {
    return resolved;
  }
  return page.mainFrame();
}

/**
 * @param {import('playwright').Page|import('selenium-webdriver').WebDriver} page
 */
async function findComposerEditor(page, engine, logger) {
  if (normalizeEngine(engine) === 'selenium') {
    const editor = await queryFirst(page, SELECTORS.composerEditor, engine);
    if (editor) {
      return editor;
    }
    return evaluateInPage(page, engine, pickComposerEditorInPage, SELECTORS.composerEditor);
  }

  const frame = await resolveComposerFrame(page, engine, logger);
  return frame || null;
}

async function fillComposerViaPlaywrightLocator(frame, text, logger) {
  const page = frame.page();
  const want = String(text).trim();
  const selectAllKey = process.platform === 'darwin' ? 'Meta+A' : 'Control+A';

  for (const selector of composerLocatorSelectors()) {
    try {
      const editors = frame.locator(selector);
      const count = await editors.count();
      for (let i = 0; i < count; i += 1) {
        const editor = editors.nth(i);
        if (!(await isComposerLocatorUsable(editor))) {
          continue;
        }

        await editor.scrollIntoViewIfNeeded();
        await editor.click({ timeout: 5000 });
        await sleep(120);

        const innerEditor = frame.locator('rich-textarea div.ql-editor[role="textbox"]').first();
        if (await isComposerLocatorUsable(innerEditor)) {
          await innerEditor.click({ timeout: 3000 });
          await sleep(80);
        }

        await page.keyboard.press(selectAllKey);
        await page.keyboard.press('Backspace');
        const lines = want.split('\n');
        for (let j = 0; j < lines.length; j += 1) {
          if (lines[j].length > 0) {
            await page.keyboard.insertText(lines[j]);
          }
          if (j < lines.length - 1) {
            await page.keyboard.press('Shift+Enter');
          }
        }
        await sleep(120);

        let got = '';
        if (await isComposerLocatorUsable(innerEditor)) {
          got = ((await innerEditor.innerText()) || '').replace(/\u200b/g, '').trim();
        }
        if (!got) {
          got = ((await editor.innerText()) || '').replace(/\u200b/g, '').trim();
        }

        if (verifyComposerFillText(got, want)) {
          logger?.info?.(
            `Composer filled via Playwright locator (${selector}): ${got.slice(0, 100)}`,
          );
          return { ok: true, via: 'playwright_locator', sample: got.slice(0, 100) };
        }

        logger?.info?.(
          `Playwright locator fill verify miss (${selector}): got ${got.length} chars, head="${got.slice(0, 60)}"`,
        );
      }
    } catch (error) {
      logger?.info?.(
        `Playwright locator fill failed (${selector}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { ok: false, reason: 'verify_fail' };
}

async function fillComposerOnAnyFrame(page, text, logger, preferredFrame = null) {
  const frames = preferredFrame ? [preferredFrame] : page.frames();
  let lastResult = { ok: false, reason: 'no_editor' };

  for (const frame of frames) {
    const locatorResult = await fillComposerViaPlaywrightLocator(frame, text, logger);
    if (locatorResult?.ok) {
      return { ...locatorResult, frame };
    }
    lastResult = locatorResult || lastResult;
  }

  return lastResult;
}

async function fillComposer(page, text, engine, logger, composeFrame = null) {
  if (normalizeEngine(engine) === 'selenium') {
    const result = await evaluateInPage(page, engine, fillComposerInPage, text, SELECTORS.composerEditor);
    if (result?.ok) {
      logger?.info(`Composer filled (strategy ${result.via}): ${result.sample || ''}`);
      return result;
    }
    logger?.info(
      `Composer fill failed: ${result?.reason || 'unknown'} — ${result?.sample || ''} (frames=${result?.framesTried ?? 1})`,
    );
    return result || { ok: false, reason: 'fill_failed' };
  }

  logger?.info('Filling composer via Playwright locators...');
  const locatorFill = await fillComposerOnAnyFrame(page, text, logger, composeFrame || null);
  if (locatorFill?.ok) {
    return locatorFill;
  }

  logger?.info(
    `Playwright locator fill failed: ${locatorFill?.reason || 'unknown'} (frames=${page.frames().length}).`,
  );
  return {
    ok: false,
    reason: locatorFill?.reason || 'no_editor',
    framesTried: page.frames().length,
  };
}

async function clickSend(page, engine, logger, composeFrame = null) {
  if (normalizeEngine(engine) === 'selenium') {
    const result = await evaluateInPage(
      page,
      engine,
      clickSendInPage,
      SELECTORS.composerEditor,
      SELECTORS.composerSendBtn,
    );
    if (result?.ok) {
      logger?.info(`Prompt sent via ${result.sendVia || 'unknown'}.`);
      return result;
    }
    logger?.info(`Send failed: ${result?.reason || 'unknown'}.`);
    return result || { ok: false, reason: 'send_failed' };
  }

  const frame = composeFrame || page.mainFrame();
  const locatorResult = await clickSendViaPlaywrightLocator(frame, logger);
  if (locatorResult?.ok) {
    return locatorResult;
  }

  logger?.info('Send via Playwright locator failed; trying all frames...');
  const anyFrameResult = await clickSendOnAnyFrame(page, engine, logger, composeFrame || null);
  if (anyFrameResult?.ok) {
    return anyFrameResult;
  }

  logger?.info(`Send failed: ${anyFrameResult?.reason || 'unknown'}.`);
  return anyFrameResult || { ok: false, reason: 'send_failed' };
}

async function getCopyPollState(page, engine, initialCopyCount) {
  if (normalizeEngine(engine) !== 'selenium') {
    return getCopyPollStateViaLocators(page, initialCopyCount);
  }

  return evaluateCopyStateInAllFrames(page, engine, getCopyPollStateInPage, {
    initialCopyCount,
    labelPatternSource: GENERATING_LABEL_PATTERN.source,
    generatingIndicatorSelectors: SELECTORS.generatingIndicators,
  });
}

async function getInitialCopyCount(page, engine) {
  if (normalizeEngine(engine) === 'selenium') {
    return evaluateInPage(page, engine, getInitialCopyCountInPage);
  }

  return getInitialCopyCountViaLocators(page);
}

/**
 * Poll until generating stops and a new copy button is usable.
 * @returns {Promise<{ ok: boolean, reason?: string, geminiReplyText?: string, center?: object }>}
 */
async function waitForResponseComplete(page, engine, logger, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? COPY_WAIT_MS;
  const stallMs = opts.stallMs ?? COPY_STALL_MS;
  const initialCopyCount = opts.initialCopyCount ?? 0;
  const deadline = Date.now() + timeoutMs;
  let responseEverStarted = false;
  let lastProgressAt = Date.now();

  while (Date.now() < deadline) {
    const state = await getCopyPollState(page, engine, initialCopyCount);
    if (state.generating) {
      responseEverStarted = true;
      lastProgressAt = Date.now();
    }
    if (state.copyCount > initialCopyCount) {
      lastProgressAt = Date.now();
    }
    if ((state.geminiReplyText || '').length > 0) {
      lastProgressAt = Date.now();
    }

    if (state.ready) {
      logger?.info(
        `Response ready (copyCount=${state.copyCount}, generating=false, domChars=${(state.geminiReplyText || '').length}).`,
      );
      return {
        ok: true,
        geminiReplyText: state.geminiReplyText,
        center: state.center,
        copyLocator: state.copyLocator || null,
        copyReason: state.geminiReplyText ? 'dom_ready' : 'copy_button_ready',
      };
    }

    if (responseEverStarted && Date.now() - lastProgressAt >= stallMs) {
      logger?.info(`Copy stall detected after ${stallMs}ms without progress.`);
      return { ok: false, reason: 'copy_stall' };
    }

    await sleep(COPY_POLL_MS);
  }

  if (!responseEverStarted) {
    logger?.info('No Gemini generating UI detected before timeout.');
    return { ok: false, reason: 'no_response' };
  }

  logger?.info('Copy button wait timeout.');
  return { ok: false, reason: 'copy_timeout' };
}

async function scrollPageToBottomForFullRender(page, engine, logger) {
  if (normalizeEngine(engine) === 'selenium') {
    try {
      await page.executeScript('window.scrollTo(0, document.body.scrollHeight);');
    } catch { /* ignore */ }
    await sleep(600);
    return;
  }
  try {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  } catch { /* ignore */ }
  // Wait for lazy-rendered content to appear in the DOM
  await sleep(700);
  // Scroll up slightly then back down to trigger any remaining lazy sections
  try {
    await page.evaluate(() => {
      window.scrollBy(0, -300);
    });
  } catch { /* ignore */ }
  await sleep(200);
  try {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  } catch { /* ignore */ }
  await sleep(400);
  logger?.info('Scrolled page to bottom for full response render.');
}

async function clickCopyButton(page, engine, logger, waitState = {}) {
  const copyLocator = waitState.copyLocator || null;

  // Scroll to bottom FIRST so Gemini lazy-renders the full response into the DOM
  // (including hashtags at the end which are typically below the fold).
  await scrollPageToBottomForFullRender(page, engine, logger);

  if (normalizeEngine(engine) !== 'selenium') {
    try {
      await page.evaluate(() => {
        if (typeof navigator?.clipboard?.writeText === 'function') {
          return navigator.clipboard.writeText('');
        }
      });
    } catch (e) {
      // ignore
    }
  }

  if (copyLocator && normalizeEngine(engine) !== 'selenium') {
    try {
      await copyLocator.scrollIntoViewIfNeeded();
      await copyLocator.click({ timeout: 5000, force: true });
      logger?.info('Copy button clicked via Playwright locator.');
      await sleep(COPY_SETTLE_MS);
      return {
        ok: true,
        copyReason: waitState.copyReason || 'playwright_locator_click',
        geminiReplyText: waitState.geminiReplyText || '',
      };
    } catch (error) {
      logger?.info(
        `Playwright copy click failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const domText = String(waitState.geminiReplyText || '').trim();
  if (domText.length >= 200) {
    logger?.info(
      `Skipping copy click — using DOM reply text (${domText.length} chars, legacy parity).`,
    );
    return {
      ok: true,
      copyReason: 'dom_only',
      geminiReplyText: domText,
    };
  }

  const state =
    waitState.center && waitState.usable !== false
      ? waitState
      : await getCopyPollState(page, engine, 0);

  if (!state.center || state.center.width < 1) {
    logger?.info('Copy button not found for click.');
    return { ok: false, reason: 'no_copy_button' };
  }

  await focusGeminiFlowPage(page, engine, logger);
  await sleep(160);

  if (normalizeEngine(engine) === 'selenium') {
    await evaluateInPage(
      page,
      engine,
      (x, y) => {
        const el = document.elementFromPoint(x, y);
        if (el) {
          try {
            el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
          } catch {
            /* ignore */
          }
          if (typeof el.click === 'function') {
            el.click();
          }
        }
      },
      state.center.x,
      state.center.y,
    );
  } else {
    await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      try {
        el?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
      } catch {
        /* ignore */
      }
    }, state.center);

    await sleep(200);
    const cdp = await dispatchCdpMouseClick(page, state.center.x, state.center.y, logger);
    if (!cdp.ok) {
      await page.mouse.click(state.center.x, state.center.y);
      logger?.info(`Copy button mouse.click fallback at (${state.center.x}, ${state.center.y}).`);
    }

    try {
      // Prefer the full-response copy button, not code block copy
      const responseCopyLocator = page.locator(
        'button[mattooltip="대답 복사"], button[mattooltip="답변 복사"], button[aria-label="대답 복사"], button[aria-label="답변 복사"]'
      ).last();
      if (await responseCopyLocator.isVisible({ timeout: 1000 })) {
        await responseCopyLocator.click({ timeout: 2000, force: true });
      }
    } catch {
      /* CDP / mouse.click is primary */
    }
  }

  logger?.info(`Copy button clicked at (${state.center.x}, ${state.center.y}).`);
  await sleep(COPY_SETTLE_MS);
  return {
    ok: true,
    copyReason: waitState.copyReason || 'cdp_click_with_dom_fallback',
    geminiReplyText: waitState.geminiReplyText || state.geminiReplyText || '',
  };
}

async function readClipboardTextInPage() {
  if (typeof navigator?.clipboard?.readText === 'function') {
    return navigator.clipboard.readText();
  }
  return '';
}

async function readClipboardMimeInPage() {
  const items = await navigator.clipboard.read();
  let html = '';
  let plain = '';
  for (const item of items) {
    if (item.types.includes('text/plain')) {
      const blob = await item.getType('text/plain');
      plain = await blob.text();
    }
    if (item.types.includes('text/html')) {
      const blob = await item.getType('text/html');
      html = await blob.text();
    }
  }
  return { html, plain };
}

/**
 * Legacy parity: readText first, then MIME text/plain, DOM fallback, text/html last.
 * @param {import('playwright').Page} page
 * @param {import('playwright').BrowserContext|null} context
 */
async function readHtmlFromClipboard(page, context, logger, opts = {}) {
  const engine = normalizeEngine(opts.engine);
  const domFallback = String(opts.domFallback || '').trim();
  let payload = '';
  let source = '';

  if (engine !== 'selenium' && context) {
    try {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
        origin: 'https://gemini.google.com',
      });
    } catch (error) {
      logger?.info(
        `clipboard permission grant skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const tryReadText = async () => {
    if (engine === 'selenium') {
      return evaluateInPage(page, engine, readClipboardTextInPage);
    }
    return page.evaluate(readClipboardTextInPage);
  };

  try {
    const readText = await tryReadText();
    if (typeof readText === 'string' && readText.trim()) {
      payload = readText.trim();
      source = 'readText';
      logger?.info(`Clipboard readText (${payload.length} chars, legacy parity).`);
    }
  } catch (error) {
    logger?.info(
      `navigator.clipboard.readText failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!payload && engine !== 'selenium') {
    try {
      const clip = await page.evaluate(readClipboardMimeInPage);
      const mimePlain = String(clip?.plain || '').trim();
      const mimeHtml = String(clip?.html || '').trim();
      if (mimePlain) {
        payload = mimePlain;
        source = 'text/plain';
        logger?.info(`Clipboard MIME text/plain (${payload.length} chars).`);
      } else if (mimeHtml && !looksLikeGeminiAppUiHtml(mimeHtml)) {
        payload = mimeHtml;
        source = 'text/html';
        logger?.info(`Clipboard MIME text/html (${payload.length} chars, readText empty).`);
      } else if (mimeHtml) {
        logger?.info(
          `Clipboard MIME text/html skipped (${mimeHtml.length} chars, gemini_ui_dom).`,
        );
      }
    } catch (error) {
      logger?.info(
        `navigator.clipboard.read failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (!payload && domFallback) {
    payload = domFallback;
    source = 'dom_fallback';
    logger?.info(`Using DOM fallback text (${payload.length} chars).`);
  }

  if (!payload && engine !== 'selenium') {
    try {
      const clip = await page.evaluate(readClipboardMimeInPage);
      const mimeHtml = String(clip?.html || '').trim();
      if (mimeHtml) {
        payload = mimeHtml;
        source = 'text/html_last_resort';
        logger?.info(`Clipboard MIME text/html last resort (${payload.length} chars).`);
      }
    } catch {
      /* ignore */
    }
  }

  if (payload && source) {
    logger?.info(`Compose clipboard source: ${source}`);
  }

  return { html: '', plain: payload.trim() };
}

/**
 * Full compose sequence — caller must ensure login + Gemini SPA beforehand.
 * Quality validation is Phase 3.
 *
 * @param {import('playwright').Page|import('selenium-webdriver').WebDriver} page
 * @param {import('playwright').BrowserContext|null} context
 * @param {{ prompt: string, engine?: string, logger?: object, timeoutMs?: number, skipSpaWait?: boolean }} options
 */
async function runComposeSequence(page, context, options = {}) {
  const engine = normalizeEngine(options.engine);
  const logger = options.logger;
  const prompt = String(options.prompt || '').trim();
  const timeoutMs = options.timeoutMs ?? COMPOSE_TIMEOUT_MS;

  if (!prompt) {
    return { ok: false, errorCode: 'missing_prompt', copyReason: 'missing_prompt', html: '', plain: '' };
  }

  if (!options.skipSpaWait) {
    const spaReady = await waitForGeminiSpaReady(page, engine, { logger });
    if (!spaReady) {
      return { ok: false, errorCode: 'spa_not_ready', copyReason: 'spa_not_ready', html: '', plain: '' };
    }
  }

  await focusGeminiFlowPage(page, engine, logger);

  const composeFrame =
    normalizeEngine(engine) === 'selenium' ? page : await resolveComposerFrame(page, engine, logger);
  if (!composeFrame && normalizeEngine(engine) !== 'selenium') {
    logger?.info('Compose frame unresolved; continuing with Playwright locator fill on all frames.');
  }

  if (isGeminiComposeDebugEnabled()) {
    await dumpGeminiComposePage(page, logger, {
      label: 'before-fill',
      selectors: composerLocatorSelectors(),
    });
  }

  const fillResult = await fillComposer(page, prompt, engine, logger, composeFrame);
  if (!fillResult.ok) {
    if (isGeminiComposeDebugEnabled()) {
      await dumpGeminiComposePage(page, logger, {
        label: 'fill-failed',
        selectors: composerLocatorSelectors(),
      });
    }
    return {
      ok: false,
      errorCode: fillResult.reason || 'verify_fail',
      copyReason: fillResult.reason || 'verify_fail',
      html: '',
      plain: '',
    };
  }

  const initialCopyCount = await getInitialCopyCount(page, engine);
  logger?.info(`Initial copy button count: ${initialCopyCount}`);

  const sendFrame =
    fillResult.frame ||
    composeFrame ||
    (normalizeEngine(engine) !== 'selenium' ? page.mainFrame() : page);
  const sendResult = await clickSend(page, engine, logger, sendFrame);
  if (!sendResult.ok) {
    return {
      ok: false,
      errorCode: 'compose_gave_up',
      copyReason: sendResult.reason || 'compose_gave_up',
      html: '',
      plain: '',
    };
  }

  let generatingSeen = false;
  const genDeadline = Date.now() + 5000;
  while (Date.now() < genDeadline) {
    if (await isGeneratingInAnyFrame(page, engine)) {
      generatingSeen = true;
      break;
    }
    await sleep(200);
  }
  if (generatingSeen) {
    logger?.info('Gemini generating UI detected after send.');
  }

  const waitResult = await waitForResponseComplete(page, engine, logger, {
    initialCopyCount,
    timeoutMs,
  });
  if (!waitResult.ok) {
    return {
      ok: false,
      errorCode: waitResult.reason,
      copyReason: waitResult.reason,
      html: '',
      plain: '',
    };
  }

  const copyClick = await clickCopyButton(page, engine, logger, waitResult);
  const domText = (
    copyClick.geminiReplyText ||
    waitResult.geminiReplyText ||
    ''
  ).trim();

  if (!copyClick.ok && domText.length < 200) {
    return {
      ok: false,
      errorCode: copyClick.reason || 'copy_click_failed',
      copyReason: copyClick.reason || 'copy_click_failed',
      html: '',
      plain: '',
    };
  }

  const clip = await readHtmlFromClipboard(page, context, logger, {
    engine,
    domFallback: domText,
  });

  if (!clip.html && !clip.plain && domText.length >= 200) {
    logger?.info(`Using DOM-only compose payload (${domText.length} chars).`);
    return {
      ok: true,
      html: '',
      plain: domText,
      copyReason: copyClick.copyReason || waitResult.copyReason || 'dom_only',
      errorCode: undefined,
    };
  }

  return {
    ok: true,
    html: clip.html,
    plain: clip.plain,
    copyReason: copyClick.copyReason || waitResult.copyReason || 'clipboard',
    errorCode: undefined,
  };
}

module.exports = {
  findComposerEditor,
  fillComposer,
  clickSend,
  waitForResponseComplete,
  clickCopyButton,
  readHtmlFromClipboard,
  runComposeSequence,
  tryFillGeminiComposer: runComposeSequence,
  focusGeminiFlowPage,
  dispatchCdpMouseClick,
  reloadGeminiPageForRetry,
  resolveComposerFrame,
  resolveComposerFrameForFill,
  ensureGeminiAppPage,
  isGeminiComposeDebugEnabled,
  dumpGeminiComposePage,
  composerLocatorSelectors,
  verifyComposerFillText,
  evaluateFirstOkInAllFrames,
  evaluateCopyStateInAllFrames,
  pickComposerEditorInPage,
  hasComposerEditorInPage,
  fillComposerInPage,
  fillComposerViaPlaywrightLocator,
  clickSendInPage,
  getCopyPollStateInPage,
  getCopyPollStateViaLocators,
  copyButtonViewportCenterToRootInPage,
  scrollPageToBottomForFullRender,
};
