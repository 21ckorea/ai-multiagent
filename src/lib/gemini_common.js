'use strict';

/**
 * @file gemini_common.js
 * @description Gemini AI 공통 로직 (선택자, 프롬프트 빌더, 파싱)
 * @purpose  Gemini 웹 UI의 DOM 선택자 관리, 프롬프트 생성/조립, Gemini 응답 파싱,
 *           SPA 로딩 대기 등 gemini 관련 모든 공통 로직의 단일 출처(SSOT).
 * @promptFiles  automation/prompts/gemini-tistory-template.txt (티스토리 SEO 본문)
 *               automation/prompts/gemini-naver-template.txt (네이버 SEO 본문)
 * @exports  SELECTORS, waitForGeminiSpaReady, getGeminiSeoInstructTemplate,
 *           buildGeminiPromptWithSeoTemplate, parseGeminiArgs, GEMINI_COMPOSE_PROMPT
 * @seeAlso  gemini_compose.js, gemini_image.js, gemini_naver_prompt.js
 */


const fs = require('fs');
const path = require('path');
const minimist = require('minimist');
const { By } = require('selenium-webdriver');
const { sleep } = require('./common');

/** Default Gemini app entry (extension GEMINI_APP_DIRECT_URL). */
const DEFAULT_GEMINI_URL = 'https://gemini.google.com/app?hl=ko';

const DEFAULT_PLAYWRIGHT_GEMINI_PROFILE_DIR = 'profiles/playwright-gemini-profile';
const DEFAULT_SELENIUM_GEMINI_PROFILE_DIR = 'profiles/selenium-gemini-profile';

const GEMINI_MODES = ['login', 'compose', 'pipeline'];

/** Minimum HTML length before Tistory handoff (bg-gemini-flow.js validateGeminiOutput). */
const GEMINI_OUTPUT_MIN_CHARS = 500;

/**
 * Compose/copy overall timeout — bg-gemini-flow.js GEMINI_FLOW_TIMEOUT_MS (3 min).
 * Shared by content compose and image flows in extension.
 */
const GEMINI_FLOW_TIMEOUT_MS = 180_000;

/** Alias for Phase 2 compose wait loops. */
const COMPOSE_TIMEOUT_MS = GEMINI_FLOW_TIMEOUT_MS;

/** Copy-button poll budget — extension GEMINI_COPY_WAIT_OVERALL_MS (= flow timeout). */
const COPY_WAIT_MS = GEMINI_FLOW_TIMEOUT_MS;

/** Stall before reload retry — extension GEMINI_COPY_STALL_RELOAD_MS (= flow timeout). */
const COPY_STALL_MS = GEMINI_FLOW_TIMEOUT_MS;

/** Shared Gemini content flow retries — bg-gemini-flow.js GEMINI_FLOW_RETRY_MAX. */
const GEMINI_FLOW_RETRY_MAX = 2;
const GEMINI_FLOW_RETRY_BACKOFF_MS = [0, 3_000, 8_000];
const GEMINI_FLOW_PULSE_VISIBLE_MS = 800;

/** Default compose tail when topic-json / session has no topic (bg-constants.js GEMINI_COMPOSE_PROMPT). */
const GEMINI_COMPOSE_PROMPT =
  'Write a SEO blog post in Korean as a single HTML <div> with inline styles.';

/** SPA poll budget — extension waitForGeminiSpaReady default 20s. */
const SPA_READY_MS = 20_000;

const SPA_HYDRATION_BUFFER_MS = 2_000;
const SPA_POLL_INTERVAL_MS = 500;

const FALLBACK_SELECTORS_FILE = path.join(__dirname, 'fallback_selectors.json');
const DEFAULT_SELECTOR_CACHE_FILE = path.resolve(process.cwd(), 'build', 'selector-cache.json');

/** Visible stop/regenerate/stop-response labels (isGeminiStillGenerating in tryFillGeminiComposer). */
const GENERATING_LABEL_PATTERN = /중지|Stop generating|일시중지|^Stop$|답변\s*중지/i;

const SELECTORS = {
  composerEditor: [
    'rich-textarea.text-input-field_textarea > div.ql-editor[role="textbox"]',
    '.text-input-field_textarea-wrapper rich-textarea.text-input-field_textarea div.ql-editor[role="textbox"]',
    'div.ql-editor[contenteditable="true"]',
    'div.ql-editor[role="textbox"]',
    'rich-textarea.text-input-field_textarea',
    '[data-test-id="prompt-textarea"]',
    'rich-textarea div.ql-editor[role="textbox"]',
    'rich-textarea',
  ],
  composerSendBtn: [
    'button.send-button[aria-disabled="false"]',
    '.send-button-container button.send-button:not([aria-disabled="true"])',
    'button.send-button',
    'button[aria-label*="보내"]',
    'button[aria-label*="Send"]',
  ],
  responseContainer: [
    '[data-test-id="model-response"]',
    '[data-test-id="message-content"]',
    '.model-response-text',
    'model-response',
    'message-content',
  ],
  responseCopyBtn: [
    '[data-test-id="copy-button"]',
    'button.copy-button',
  ],
  /** DOM roots scanned by isGeminiStillGenerating (button aria-label / mattooltip). */
  generatingIndicators: [
    'button[aria-label]',
    '[mat-button][aria-label]',
    'button[mattooltip]',
  ],
  spaEditor: [
    'div.ql-editor[role="textbox"]',
    'div.ql-editor[contenteditable="true"]',
  ],
  spaChatWindow: ['chat-window'],
  spaAppShell: ['gemini-app'],
  /** Phase 11+ image flow — export only, not used in Phase 1–2 compose MVP. */
  image: {
    toolBtn: ['button[aria-label*="이미지 만들기"]', "button.card.card-zero-state[aria-label*='이미지']"],
    uploadToolsBtn: [
      'button[aria-label="업로드 및 도구"]',
      "gem-icon-button.menu-button button[aria-haspopup='menu']",
    ],
    imageMenuLabel: ['div.label.gem-menu-item-label', '.gem-menu-item-label'],
    imageMenuButton: ['toolbox-drawer-item button', 'mat-action-list button'],
    imageMenuItem: ['toolbox-drawer-item button', 'div.label.gem-menu-item-label'],
    overlay: ['div.overlay-container'],
    copyBtn: [
      'copy-button button[aria-label="이미지 복사"]',
      'button.copy-button[aria-label="이미지 복사"]',
    ],
  },
};

function asSelectorArray(value, fallback = []) {
  if (Array.isArray(value)) {
    return value.filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    return [value.trim()];
  }
  return fallback;
}

function loadFallbackSelectorTree() {
  if (!fs.existsSync(FALLBACK_SELECTORS_FILE)) {
    throw new Error(`fallback selectors missing: ${FALLBACK_SELECTORS_FILE}`);
  }
  return JSON.parse(fs.readFileSync(FALLBACK_SELECTORS_FILE, 'utf8'));
}

function readSelectorCache(cacheFile = DEFAULT_SELECTOR_CACHE_FILE) {
  try {
    if (!fs.existsSync(cacheFile)) {
      return null;
    }
    const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (!parsed?.data || typeof parsed.data !== 'object') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeSelectorCache(data, meta, cacheFile = DEFAULT_SELECTOR_CACHE_FILE) {
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(
      cacheFile,
      JSON.stringify(
        {
          data,
          meta: meta && typeof meta === 'object' ? meta : {},
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      'utf8',
    );
  } catch (error) {
    // Non-fatal cache write.
  }
}

/**
 * @param {Record<string, { updatedAt?: string }>|null|undefined} localMeta
 * @param {Record<string, { updatedAt?: string }>|null|undefined} serverMeta
 * @returns {boolean}
 */
function isSelectorMetaStale(localMeta, serverMeta) {
  const server = serverMeta && typeof serverMeta === 'object' ? serverMeta : {};
  const local = localMeta && typeof localMeta === 'object' ? localMeta : {};
  const keys = new Set([...Object.keys(server), ...Object.keys(local)]);
  for (const key of keys) {
    const localAt = String(local[key]?.updatedAt || '').trim();
    const serverAt = String(server[key]?.updatedAt || '').trim();
    if (!serverAt) {
      continue;
    }
    if (!localAt || localAt !== serverAt) {
      return true;
    }
  }
  return Object.keys(server).length > 0 && Object.keys(local).length === 0;
}

/**
 * Mutate module SELECTORS from server/fallback gemini.* tree (bg-selectors.js mapping).
 * @param {object} geminiTree
 */
function applyGeminiSelectorsFromTree(geminiTree) {
  const g = geminiTree && typeof geminiTree === 'object' ? geminiTree : {};

  SELECTORS.composerEditor = asSelectorArray(g.composer?.editor, SELECTORS.composerEditor);
  SELECTORS.composerSendBtn = asSelectorArray(g.composer?.sendBtn, SELECTORS.composerSendBtn);
  SELECTORS.responseContainer = asSelectorArray(g.response?.container, SELECTORS.responseContainer);
  SELECTORS.responseCopyBtn = asSelectorArray(g.response?.copyBtn, SELECTORS.responseCopyBtn);
  SELECTORS.spaEditor = asSelectorArray(g.spa?.editor, SELECTORS.spaEditor);
  SELECTORS.spaChatWindow = asSelectorArray(g.spa?.chatWindow, SELECTORS.spaChatWindow);
  SELECTORS.spaAppShell = asSelectorArray(g.spa?.app, SELECTORS.spaAppShell);

  SELECTORS.image.toolBtn = asSelectorArray(g.image?.toolBtn, SELECTORS.image.toolBtn);
  SELECTORS.image.uploadToolsBtn = asSelectorArray(
    g.image?.uploadToolsBtn,
    SELECTORS.image.uploadToolsBtn,
  );
  SELECTORS.image.imageMenuLabel = asSelectorArray(
    g.image?.imageMenuLabel,
    SELECTORS.image.imageMenuLabel,
  );
  SELECTORS.image.imageMenuButton = asSelectorArray(
    g.image?.imageMenuButton,
    SELECTORS.image.imageMenuButton,
  );
  SELECTORS.image.imageMenuItem = asSelectorArray(
    g.image?.imageMenuItem,
    SELECTORS.image.imageMenuItem,
  );
  SELECTORS.image.overlay = asSelectorArray(g.image?.overlay, SELECTORS.image.overlay);
  SELECTORS.image.copyBtn = asSelectorArray(g.image?.copyBtn, SELECTORS.image.copyBtn);
}

/**
 * Load Gemini selectors: fallback file → disk cache (no per-run server fetch).
 * Pass `forceRefresh: true` (login sync) to fetch server selectors when meta differs.
 * @param {{ logger?: object, cacheFile?: string, tokenFile?: string, forceRefresh?: boolean, serverPayload?: { selectors?: object, meta?: object } }} [options]
 * @returns {Promise<{ source: string, geminiKeys: string[] }>}
 */
async function initGeminiSelectors(options = {}) {
  const logger = options.logger;
  const cacheFile = options.cacheFile || DEFAULT_SELECTOR_CACHE_FILE;
  const fallbackTree = loadFallbackSelectorTree();
  applyGeminiSelectorsFromTree(fallbackTree.gemini || {});
  let source = 'fallback_file';

  const cached = readSelectorCache(cacheFile);
  if (cached?.data?.gemini) {
    applyGeminiSelectorsFromTree(cached.data.gemini);
    source = 'cache_file';
  }

  const applyServerPayload = (selectors, meta) => {
    if (selectors?.gemini && typeof selectors.gemini === 'object') {
      applyGeminiSelectorsFromTree(selectors.gemini);
      writeSelectorCache(selectors, meta, cacheFile);
      source = 'server';
      logger?.info?.(
        `[ServerAPI] fetchSelectors ok gemini keys=${Object.keys(selectors.gemini).join(',')}`,
      );
    }
  };

  if (options.serverPayload?.selectors) {
    applyServerPayload(options.serverPayload.selectors, options.serverPayload.meta);
  } else if (options.forceRefresh) {
    const { fetchSelectors, resolveIdToken } = require('./server_api');
    if (resolveIdToken({ tokenFile: options.tokenFile, logger })) {
      try {
        const { selectors, meta } = await fetchSelectors(
          ['tistory', 'naver', 'gemini', 'google'],
          {
            tokenFile: options.tokenFile,
            logger,
          },
        );
        if (!isSelectorMetaStale(cached?.meta, meta)) {
          logger?.info?.('[ServerAPI] fetchSelectors skipped (meta unchanged)');
        } else {
          applyServerPayload(selectors, meta);
        }
      } catch (error) {
        logger?.info?.(
          `[ServerAPI] fetchSelectors skipped: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else {
      logger?.info?.('[ServerAPI] fetchSelectors skipped (no auth token)');
    }
  } else {
    logger?.info?.('[ServerAPI] fetchSelectors skipped (use disk cache at publish time)');
  }

  const geminiKeys = Object.keys(fallbackTree.gemini || {});
  logger?.info?.(`[ServerAPI] selectors source=${source} gemini.* sections=${geminiKeys.join(',')}`);
  return { source, geminiKeys };
}

/**
 * Top-level Gemini app host (bg-gemini-flow.js isGeminiAppTopLevelUrl).
 * Do not use url.includes("gemini.google.com") on Google sign-in redirect URLs.
 */
function isGeminiAppUrl(url) {
  if (typeof url !== 'string' || !url.length) {
    return false;
  }
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === 'gemini.google.com' || hostname.endsWith('.gemini.google.com');
  } catch {
    return false;
  }
}

function normalizeEngine(engine) {
  const value = String(engine || 'playwright').toLowerCase();
  if (value === 'selenium') {
    return 'selenium';
  }
  return 'playwright';
}

async function getPageUrl(pageOrDriver, engine) {
  if (normalizeEngine(engine) === 'selenium') {
    try {
      return await pageOrDriver.getCurrentUrl();
    } catch {
      return '';
    }
  }
  try {
    return pageOrDriver.url();
  } catch {
    return '';
  }
}

/**
 * First visible match across a selector fallback chain.
 * @param {import('playwright').Page|import('selenium-webdriver').WebDriver} page
 * @param {string[]} selectors
 * @param {'playwright'|'selenium'|string} engine
 */
async function queryFirst(page, selectors, engine) {
  const chain = Array.isArray(selectors) ? selectors : [selectors];
  if (normalizeEngine(engine) === 'selenium') {
    for (const selector of chain) {
      if (!selector) {
        continue;
      }
      try {
        const elements = await page.findElements(By.css(selector));
        for (const element of elements) {
          if (await element.isDisplayed()) {
            return element;
          }
        }
      } catch {
        // Try next selector.
      }
    }
    return null;
  }

  for (const selector of chain) {
    if (!selector) {
      continue;
    }
    try {
      const locator = page.locator(selector).first();
      if (await locator.isVisible({ timeout: 500 })) {
        return locator;
      }
    } catch {
      // Try next selector.
    }
  }
  return null;
}

/** In-page SPA readiness probe (extension waitForGeminiSpaReady MAIN func, compose subset). */
function evaluateSpaReadyStateInPage(selBundle) {
  function qFirst(candidates) {
    for (const selector of candidates || []) {
      if (!selector) {
        continue;
      }
      const el = document.querySelector(selector);
      if (el) {
        return el;
      }
    }
    return null;
  }

  const editor = qFirst(selBundle.spaEditor);
  const editorOk = !!(editor && (editor.isContentEditable || editor.getAttribute('role') === 'textbox'));

  let appShell = false;
  for (const selector of selBundle.spaAppShell || []) {
    if (document.querySelector(selector)) {
      appShell = true;
      break;
    }
  }
  if (!appShell) {
    for (const selector of selBundle.spaChatWindow || []) {
      if (document.querySelector(selector)) {
        appShell = true;
        break;
      }
    }
  }

  return { editorOk, appShell };
}

async function evaluateSpaReadyState(page, engine) {
  const selBundle = {
    spaEditor: SELECTORS.spaEditor,
    spaChatWindow: SELECTORS.spaChatWindow,
    spaAppShell: SELECTORS.spaAppShell,
  };

  if (normalizeEngine(engine) === 'selenium') {
    const script = `
      const fn = ${evaluateSpaReadyStateInPage.toString()};
      return fn(arguments[0]);
    `;
    return page.executeScript(script, selBundle);
  }

  return page.evaluate(evaluateSpaReadyStateInPage, selBundle);
}

async function evaluateSpaReadyStateAllFrames(page, engine) {
  const selBundle = {
    spaEditor: SELECTORS.spaEditor,
    spaChatWindow: SELECTORS.spaChatWindow,
    spaAppShell: SELECTORS.spaAppShell,
  };

  if (normalizeEngine(engine) === 'selenium') {
    return evaluateSpaReadyState(page, engine);
  }

  let merged = { editorOk: false, appShell: false };
  for (const frame of page.frames()) {
    try {
      const state = await frame.evaluate(evaluateSpaReadyStateInPage, selBundle);
      if (!state) {
        continue;
      }
      if (state.editorOk && state.appShell) {
        return state;
      }
      merged = {
        editorOk: merged.editorOk || state.editorOk,
        appShell: merged.appShell || state.appShell,
      };
      if (merged.editorOk && merged.appShell) {
        return merged;
      }
    } catch {
      /* try next frame */
    }
  }

  return merged;
}

/**
 * Poll until ql-editor is visible on gemini.google.com/app (extension SPA ready, simplified).
 */
async function waitForGeminiSpaReady(page, engine, options = {}) {
  const timeoutMs = options.timeoutMs ?? SPA_READY_MS;
  const logger = options.logger;
  const deadline = Date.now() + timeoutMs;
  let pollCount = 0;

  while (Date.now() < deadline) {
    pollCount += 1;
    const url = await getPageUrl(page, engine);

    if (!isGeminiAppUrl(url) || !/\/app/i.test(url)) {
      if (pollCount === 1 && logger) {
        logger.info(`Gemini SPA wait: not on /app yet (${url || '(empty)'})`);
      }
      await sleep(SPA_POLL_INTERVAL_MS);
      continue;
    }

    let state = { editorOk: false, appShell: false };
    try {
      state = (await evaluateSpaReadyStateAllFrames(page, engine)) || state;
    } catch (error) {
      if (pollCount <= 2 && logger) {
        logger.info(`Gemini SPA poll error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (state.editorOk && state.appShell) {
      if (logger) {
        logger.info(
          `Gemini SPA ready after ${Date.now() - (deadline - timeoutMs)}ms; hydration buffer ${SPA_HYDRATION_BUFFER_MS}ms`,
        );
      }
      await sleep(SPA_HYDRATION_BUFFER_MS);
      return true;
    }

    await sleep(SPA_POLL_INTERVAL_MS);
  }

  if (logger) {
    logger.info(`Gemini SPA ready timeout after ${timeoutMs}ms (${pollCount} polls).`);
  }
  return false;
}

/** Port of tryFillGeminiComposer isGeminiStillGenerating (bg-gemini-flow.js). */
function isGeminiStillGeneratingInPage(arg1, arg2) {
  let indicatorSelectors;
  let labelPatternSource;
  if (arg1 && typeof arg1 === 'object' && !Array.isArray(arg1)) {
    indicatorSelectors = arg1.indicatorSelectors;
    labelPatternSource = arg1.labelPatternSource;
  } else {
    indicatorSelectors = arg1;
    labelPatternSource = arg2;
  }

  const labelPattern = new RegExp(labelPatternSource);
  const nodes = document.querySelectorAll(
    (indicatorSelectors || []).join(', ') ||
    'button[aria-label], [mat-button][aria-label], button[mattooltip]',
  );

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
        return true;
      }
    }
  }

  return false;
}

async function isGeminiStillGenerating(page, engine) {
  const args = [SELECTORS.generatingIndicators, GENERATING_LABEL_PATTERN.source];

  if (normalizeEngine(engine) === 'selenium') {
    const script = `
      const fn = ${isGeminiStillGeneratingInPage.toString()};
      return fn(arguments[0], arguments[1]);
    `;
    return page.executeScript(script, ...args);
  }

  return page.evaluate(isGeminiStillGeneratingInPage, {
    indicatorSelectors: SELECTORS.generatingIndicators,
    labelPatternSource: GENERATING_LABEL_PATTERN.source,
  });
}

function geminiFlowAttemptCount() {
  return GEMINI_FLOW_RETRY_MAX + 1;
}

function canGeminiFlowRetry(attemptIndex) {
  return attemptIndex < GEMINI_FLOW_RETRY_MAX;
}

function geminiFlowRetryDelayMs(attemptIndex) {
  return (
    GEMINI_FLOW_RETRY_BACKOFF_MS[attemptIndex] ??
    GEMINI_FLOW_RETRY_BACKOFF_MS[GEMINI_FLOW_RETRY_BACKOFF_MS.length - 1]
  );
}

function formatGeminiDateKo() {
  return new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date());
}

function normalizeGeminiTopicSlot(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      presetKey: null,
      customText: '',
      _topicRowId: '',
      categoryId: '',
      subjectId: '',
      generateThumbnail: false,
    };
  }
  const slot = {
    presetKey: raw.presetKey != null ? raw.presetKey : null,
    customText: typeof raw.customText === 'string' ? raw.customText : '',
    _topicRowId: typeof raw._topicRowId === 'string' ? raw._topicRowId : '',
    categoryId: typeof raw.categoryId === 'string' ? raw.categoryId : '',
    subjectId: typeof raw.subjectId === 'string' ? raw.subjectId : '',
    generateThumbnail: raw.generateThumbnail === true,
  };
  if (typeof raw.isPublic === 'boolean') {
    slot.isPublic = raw.isPublic;
  }
  // Per-topic prompt template (글 종류별). Preserved so batch_publish.js can
  // prefer it over the account-level fallback prompt.
  if (typeof raw.promptOverride === 'string' && raw.promptOverride.trim()) {
    slot.promptOverride = raw.promptOverride;
  }
  // 맛집리뷰 + 직접 이미지 첨부: skip body image generation step.
  if (raw.skipPlaceholderImages === true) {
    slot.skipPlaceholderImages = true;
  }
  return slot;
}

/** bg-gemini-flow.js resolveGeminiPromptFromTopic */
function resolveGeminiPromptFromTopic(meta) {
  const topic = normalizeGeminiTopicSlot(meta);
  const customText = topic.customText.trim();
  const dateKo = formatGeminiDateKo();
  if (topic.presetKey === 'issues') {
    return `${dateKo} 기준 최신 이슈에 대해서`;
  }
  if (topic.presetKey === 'kr-market') {
    return `${dateKo} 기준 최신국내증시에 대해서`;
  }
  if (topic.presetKey === 'us-market') {
    return `${dateKo} 기준 최신미국증시에 대해서`;
  }
  if (customText.length > 0) {
    return customText;
  }
  return GEMINI_COMPOSE_PROMPT;
}

/** bg-gemini-flow.js resolveGeminiPromptForSession */
function resolveGeminiPromptForSession(rec) {
  if (rec?.geminiTopic && typeof rec.geminiTopic === 'object') {
    return resolveGeminiPromptFromTopic(rec.geminiTopic);
  }
  if (typeof rec?.geminiPrompt === 'string' && rec.geminiPrompt.trim().length > 0) {
    return rec.geminiPrompt.trim();
  }
  return GEMINI_COMPOSE_PROMPT;
}

/** Local fallback when server fetch is unavailable (T1-P7).
 * 프롬프트 내용은 automation/prompts/gemini-tistory-template.txt 파일로 관리됩니다.
 * 수정 시 해당 파일을 직접 편집하세요. (JS 인라인은 파일 없을 때 fallback)
 * @param {string} [keyword] - Optional topic/keyword to append at the end.
 */
const _TISTORY_TEMPLATE_FILE = path.join(__dirname, 'prompts', 'gemini-tistory-template.txt');
function getGeminiSeoInstructTemplate(keyword) {
  if (!fs.existsSync(_TISTORY_TEMPLATE_FILE)) {
    throw new Error(`[GeminiCommon] 필수 프롬프트 파일이 없습니다: ${_TISTORY_TEMPLATE_FILE}`);
  }
  const raw = fs.readFileSync(_TISTORY_TEMPLATE_FILE, 'utf8');
  const base = raw.replace(/^={10,}[\s\S]*?={10,}\r?\n?/, '').trim();
  if (!base) {
    throw new Error(`[GeminiCommon] 프롬프트 파일이 비어있습니다: ${_TISTORY_TEMPLATE_FILE}`);
  }
  return keyword ? `${base}${keyword}` : base;
}
const {
  getGeminiNaverLocalPromptTemplate,
  getGeminiNaverServerFallbackTemplate,
  appendTopicToNaverPromptBase,
} = require('./gemini_naver_prompt');

/**
 * Local SEO prompt template (server fetch via resolveGeminiPromptForCompose + --use-server-prompt).
 * @param {object} rec Session-like record from --topic-json
 * @param {string} [topicLineOverride]
 * @param {{ serverFetchFailed?: boolean, flowTarget?: string }} [options]
 */
function buildGeminiPromptWithSeoTemplate(rec, topicLineOverride, options = {}) {
  const flowTarget = options.flowTarget || rec?.flowTarget || '';
  const platform = flowTarget === 'naver' ? 'naver' : 'tistory';
  const topicLine =
    typeof topicLineOverride === 'string' ? topicLineOverride : resolveGeminiPromptForSession(rec);

  if (platform === 'naver') {
    const base = options.serverFetchFailed
      ? getGeminiNaverServerFallbackTemplate()
      : getGeminiNaverLocalPromptTemplate();
    return appendTopicToNaverPromptBase(base, topicLine);
  }

  const tail = String(topicLine).replace(/\s+/g, ' ').trim();
  const base = getGeminiSeoInstructTemplate();
  if (!tail) {
    return base;
  }
  return `${base} ${tail}`;
}

/**
 * Compose/pipeline prompt resolution with optional server fetch (--use-server-prompt).
 * @param {object} args parseGeminiArgs() output
 * @param {object} [logger]
 * @returns {Promise<ReturnType<typeof buildGeminiPromptFromArgs>>}
 */
async function resolveGeminiPromptForCompose(args = {}, logger) {
  const directPrompt = String(args.prompt || '').trim();
  if (directPrompt) {
    return {
      ok: true,
      prompt: directPrompt,
      promptSource: 'cli',
      flowTarget: args.flowTarget || '',
      workflowKind: args.workflowKind || '',
      ctaDesign: args.ctaDesign || null,
      titleText: args.titleText || '',
      topicFallback: args.topicFallback || '',
    };
  }

  let rec = args.topicJsonRecord;
  if (!rec && args.topicJsonRaw) {
    try {
      rec = parseTopicJsonRecord(args.topicJsonRaw);
    } catch (error) {
      return {
        ok: false,
        error: 'invalid_topic_json',
        errorDetail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (!rec || typeof rec !== 'object') {
    return buildGeminiPromptFromArgs(args);
  }

  const meta = extractTopicMetadata(rec);
  const flowTarget = rec.flowTarget || args.flowTarget || '';
  const platform = flowTarget === 'naver' ? 'naver' : 'tistory';
  const useServerPrompt = args.useServerPrompt !== false;

  if (useServerPrompt) {
    const { assemblePrompt, ensureTemplate } = require('./prompt_cache');
    try {
      const { body, source } = await ensureTemplate(
        platform,
        {
          tokenFile: args.tokenFile || args.tokenFilePath,
          promptTemplateCache: args.promptTemplateCache,
          cacheDir: args.promptCacheDir,
          maxAgeMs: args.promptCacheMaxAgeMs,
          logger,
        },
        logger,
      );
      const prompt = assemblePrompt(platform, body, rec.geminiTopic || null).trim();
      if (!prompt) {
        return {
          ok: false,
          error: 'missing_prompt',
          errorDetail: 'assembled prompt is empty',
          ...meta,
        };
      }
      logger?.info?.(
        `[PromptCache] compose platform=${platform} source=${source} chars=${prompt.length}`,
      );
      return {
        ok: true,
        prompt,
        promptSource: source,
        ...meta,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logger?.info?.(`[PromptCache] compose failed platform=${platform}: ${detail}`);
      return {
        ok: false,
        error: 'prompt_template_unavailable',
        errorDetail: detail,
        ...meta,
      };
    }
  }

  const localPrompt = buildGeminiPromptWithSeoTemplate(rec, undefined, {
    flowTarget,
  }).trim();
  if (!localPrompt) {
    return { ok: false, error: 'missing_prompt', errorDetail: 'topic-json produced empty prompt' };
  }

  return {
    ok: true,
    prompt: localPrompt,
    promptSource: 'local',
    ...meta,
  };
}

function readTopicJsonFile(topicJsonRaw) {
  const resolved = path.resolve(process.cwd(), String(topicJsonRaw || '').trim());
  if (!fs.existsSync(resolved)) {
    throw new Error(`topic-json file not found: ${resolved}`);
  }
  const text = fs.readFileSync(resolved, 'utf8');
  return JSON.parse(text);
}

function parseTopicJsonRecord(raw) {
  if (!raw) {
    return null;
  }
  if (typeof raw === 'object') {
    return raw;
  }
  const text = String(raw).trim();
  if (!text) {
    return null;
  }
  if (text.startsWith('{') || text.startsWith('[')) {
    return JSON.parse(text);
  }
  return readTopicJsonFile(text);
}

function extractTopicMetadata(rec) {
  const topic = normalizeGeminiTopicSlot(rec?.geminiTopic);
  const topicFallback =
    topic.customText.trim() ||
    (topic.presetKey != null ? String(topic.presetKey).trim() : '');
  const ctaDesign = rec?.ctaDesign && typeof rec.ctaDesign === 'object' ? rec.ctaDesign : null;
  const titleText =
    String(rec?.titleText || ctaDesign?.ctaHeadline || '').trim() || topicFallback;

  return {
    flowTarget: rec?.flowTarget || '',
    workflowKind: rec?.workflowKind || '',
    ctaDesign,
    titleText,
    topicFallback,
    geminiTopic: topic,
  };
}

/**
 * Resolve compose prompt + handoff metadata from CLI args.
 * Priority: --prompt → --prompt-file (already merged in parseGeminiArgs) → --topic-json SEO template.
 * @returns {{ ok: boolean, prompt?: string, error?: string, errorDetail?: string, flowTarget?: string, workflowKind?: string, ctaDesign?: object|null, titleText?: string, topicFallback?: string }}
 */
function buildGeminiPromptFromArgs(args = {}) {
  const directPrompt = String(args.prompt || '').trim();
  if (directPrompt) {
    return {
      ok: true,
      prompt: directPrompt,
      flowTarget: args.flowTarget || '',
      workflowKind: args.workflowKind || '',
      ctaDesign: args.ctaDesign || null,
      titleText: args.titleText || '',
      topicFallback: args.topicFallback || '',
    };
  }

  if (!args.topicJsonRecord && !args.topicJsonRaw) {
    return { ok: false, error: 'missing_prompt', errorDetail: 'Provide --prompt, --prompt-file, or --topic-json' };
  }

  let rec;
  try {
    rec = args.topicJsonRecord || parseTopicJsonRecord(args.topicJsonRaw);
  } catch (error) {
    return {
      ok: false,
      error: 'invalid_topic_json',
      errorDetail: error instanceof Error ? error.message : String(error),
    };
  }

  if (!rec || typeof rec !== 'object') {
    return { ok: false, error: 'invalid_topic_json', errorDetail: 'Expected JSON object' };
  }

  const meta = extractTopicMetadata(rec);
  const prompt = buildGeminiPromptWithSeoTemplate(rec, undefined, {
    flowTarget: rec.flowTarget || '',
  }).trim();
  if (!prompt) {
    return { ok: false, error: 'missing_prompt', errorDetail: 'topic-json produced empty prompt' };
  }

  return {
    ok: true,
    prompt,
    ...meta,
  };
}

function parseBoolGeminiArg(value, defaultValue = false) {
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }
  return defaultValue;
}

function parseGeminiArgs() {
  const args = minimist(process.argv.slice(2), {
    string: [
      'email',
      'password',
      'url',
      'mode',
      'prompt',
      'prompt-file',
      'promptFile',
      'topic-json',
      'topicJson',
      'profile-dir',
      'profileDir',
      'output-file',
      'outputFile',
    ],
    boolean: ['headless', 'use-server-prompt', 'useServerPrompt'],
    default: {
      url: DEFAULT_GEMINI_URL,
      mode: 'login',
      headless: false,
      'use-server-prompt': false,
    },
  });

  const modeRaw = String(args.mode || 'login').toLowerCase();
  const mode = GEMINI_MODES.includes(modeRaw) ? modeRaw : 'login';

  let prompt = String(args.prompt || '').trim();
  const promptFileRaw = String(args['prompt-file'] || args.promptFile || '').trim();
  let promptFile = '';

  if (!prompt && promptFileRaw) {
    promptFile = path.resolve(process.cwd(), promptFileRaw);
    if (fs.existsSync(promptFile)) {
      prompt = fs.readFileSync(promptFile, 'utf8').trim();
    }
  } else if (promptFileRaw) {
    promptFile = path.resolve(process.cwd(), promptFileRaw);
  }

  const profileDirRaw = String(
    args['profile-dir'] || args.profileDir || DEFAULT_PLAYWRIGHT_GEMINI_PROFILE_DIR,
  ).trim();

  const outputFileRaw = String(args['output-file'] || args.outputFile || '').trim();
  const topicJsonRaw = String(args['topic-json'] || args.topicJson || '').trim();
  let topicJsonRecord = null;
  let topicJsonPath = '';

  if (topicJsonRaw) {
    topicJsonPath = path.isAbsolute(topicJsonRaw)
      ? topicJsonRaw
      : path.resolve(process.cwd(), topicJsonRaw);
    try {
      topicJsonRecord = parseTopicJsonRecord(topicJsonRaw);
    } catch {
      topicJsonRecord = null;
    }
  }

  const useServerPrompt = parseBoolGeminiArg(
    args['use-server-prompt'] ?? args.useServerPrompt,
    false,
  );

  const topicMeta = topicJsonRecord ? extractTopicMetadata(topicJsonRecord) : null;
  let promptBuild = {
    flowTarget: topicMeta?.flowTarget || '',
    workflowKind: topicMeta?.workflowKind || '',
    ctaDesign: topicMeta?.ctaDesign || null,
    titleText: topicMeta?.titleText || '',
    topicFallback: topicMeta?.topicFallback || '',
  };

  if (!prompt && !useServerPrompt) {
    promptBuild = buildGeminiPromptFromArgs({
      prompt,
      topicJsonRaw,
      topicJsonRecord,
      ...promptBuild,
    });

    if (promptBuild.ok && promptBuild.prompt) {
      prompt = promptBuild.prompt;
    }
  }

  return {
    email: String(args.email || '').trim(),
    password: args.password || '',
    url: String(args.url || DEFAULT_GEMINI_URL).trim() || DEFAULT_GEMINI_URL,
    mode,
    prompt,
    promptFile,
    topicJsonRaw,
    topicJsonPath,
    topicJsonRecord,
    flowTarget: promptBuild.flowTarget || topicMeta?.flowTarget || '',
    workflowKind: promptBuild.workflowKind || topicMeta?.workflowKind || '',
    ctaDesign: promptBuild.ctaDesign || topicMeta?.ctaDesign || null,
    titleText: promptBuild.titleText || topicMeta?.titleText || '',
    topicFallback: promptBuild.topicFallback || topicMeta?.topicFallback || '',
    useServerPrompt,
    profileDir: path.resolve(process.cwd(), profileDirRaw),
    outputFile: outputFileRaw ? path.resolve(process.cwd(), outputFileRaw) : '',
    headless: args.headless === true,
  };
}

/**
 * Validates Gemini HTML before handoff (bg-gemini-flow.js validateGeminiOutput).
 * @deprecated Use gemini_validate.js — kept for Phase 1 imports.
 */
function validateGeminiOutput(html) {
  const { validateGeminiOutput: validate } = require('./gemini_validate');
  return validate(html);
}

function logHtmlJsonLine(logger, payload) {
  const { logHtmlHandoff } = require('./gemini_validate');
  if (payload?.html) {
    logHtmlHandoff(logger, payload.html, payload.path ?? '');
    return;
  }
  logger.info(
    `[Gemini] [HTML] ${JSON.stringify({
      chars: payload?.chars ?? 0,
      preview: payload?.preview ?? '',
      path: payload?.path ?? '',
      placeholderCount: payload?.placeholderCount ?? 0,
    })}`,
  );
}

function logGeminiError(logger, code, detail) {
  const suffix = detail ? ` — ${detail}` : '';
  logger.info(`[Gemini] [ERROR] ${code}${suffix}`);
}

module.exports = {
  DEFAULT_GEMINI_URL,
  DEFAULT_PLAYWRIGHT_GEMINI_PROFILE_DIR,
  DEFAULT_SELENIUM_GEMINI_PROFILE_DIR,
  GEMINI_MODES,
  GEMINI_OUTPUT_MIN_CHARS,
  GEMINI_FLOW_TIMEOUT_MS,
  COMPOSE_TIMEOUT_MS,
  COPY_WAIT_MS,
  COPY_STALL_MS,
  GEMINI_FLOW_RETRY_MAX,
  GEMINI_FLOW_RETRY_BACKOFF_MS,
  GEMINI_FLOW_PULSE_VISIBLE_MS,
  GEMINI_COMPOSE_PROMPT,
  geminiFlowAttemptCount,
  canGeminiFlowRetry,
  geminiFlowRetryDelayMs,
  formatGeminiDateKo,
  normalizeGeminiTopicSlot,
  resolveGeminiPromptFromTopic,
  resolveGeminiPromptForSession,
  getGeminiSeoInstructTemplate,
  buildGeminiPromptWithSeoTemplate,
  buildGeminiPromptFromArgs,
  resolveGeminiPromptForCompose,
  initGeminiSelectors,
  applyGeminiSelectorsFromTree,
  loadFallbackSelectorTree,
  readSelectorCache,
  writeSelectorCache,
  isSelectorMetaStale,
  DEFAULT_SELECTOR_CACHE_FILE,
  parseTopicJsonRecord,
  SPA_READY_MS,
  SPA_HYDRATION_BUFFER_MS,
  SPA_POLL_INTERVAL_MS,
  GENERATING_LABEL_PATTERN,
  SELECTORS,
  isGeminiAppUrl,
  queryFirst,
  getPageUrl,
  waitForGeminiSpaReady,
  isGeminiStillGenerating,
  isGeminiStillGeneratingInPage,
  parseGeminiArgs,
  validateGeminiOutput,
  logHtmlJsonLine,
  logGeminiError,
};
