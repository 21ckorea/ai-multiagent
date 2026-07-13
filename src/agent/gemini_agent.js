'use strict';

/**
 * @file gemini_agent.js
 * @description Playwright 기반 Gemini 실제 호출 엔진
 * @reference  references/gemini_compose.js 핵심 패턴 적용
 *             - fillComposerInPage: document.execCommand('insertText')
 *             - clickSendInPage: Enter KeyboardEvent 디스패치
 *             - 응답 추출: copy-button locator → model-response DOM
 */

const path = require('path');
const fs   = require('fs');

const DEFAULT_PROFILE_DIR = path.resolve(process.cwd(), 'profiles', 'gemini-profile');
const GEMINI_APP_URL      = 'https://gemini.google.com/app';

// ── 셀렉터 (references/gemini_common.js SELECTORS 참고) ──────────────────────
const COMPOSER_SELECTORS = [
  'rich-textarea.text-input-field_textarea > div.ql-editor[role="textbox"]',
  'rich-textarea div.ql-editor[role="textbox"]',
  'rich-textarea div.ql-editor',
  '[data-test-id="prompt-textarea"] div.ql-editor',
  '[data-test-id="prompt-textarea"]',
  'div.ql-editor[contenteditable="true"]',
  'div.ql-editor[role="textbox"]',
  'rich-textarea',
  '[aria-label*="입력" i][contenteditable="true"]',
  '[contenteditable="true"][role="textbox"]',
];

const SEND_BTN_SELECTORS = [
  'button.send-button[aria-disabled="false"]',
  'button.send-button:not([aria-disabled="true"])',
  'button.send-button',
  'button[aria-label*="보내"]',
  'button[aria-label*="Send"]',
];

const RESPONSE_SELECTORS = [
  '[data-test-id="model-response"]',
  '[data-test-id="message-content"]',
  'model-response',
  '.model-response-text',
  'message-content',
];

const COPY_BTN_SELECTORS = [
  'button[aria-label="대답 복사"]',
  'button[mattooltip="대답 복사"]',
  'button[aria-label="답변 복사"]',
  'button[mattooltip="답변 복사"]',
  '[data-test-id="copy-button"]',
  'button.copy-button',
];

// 생성 중 감지 패턴
const GENERATING_PATTERN = /중지|Stop generating|일시중지|^Stop$|답변\s*중지|생성\s*중지/i;

const SPA_TIMEOUT_MS    = 30_000;
const RESPONSE_TIMEOUT  = 180_000;
const POLL_MS           = 600;
const HYDRATION_MS      = 2_500;

// ── 내부 브라우저 상태 ────────────────────────────────────────────────────────
let _context = null;
let _page    = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── 브라우저 컨텍스트 획득/재사용 ────────────────────────────────────────────
async function getOrCreateContext() {
  if (_context && _page) {
    // 페이지가 살아있는지 확인
    try {
      await _page.title();
      return { context: _context, page: _page };
    } catch {
      _context = null;
      _page    = null;
    }
  }

  const { chromium } = require('playwright');
  fs.mkdirSync(DEFAULT_PROFILE_DIR, { recursive: true });

  // ── 고아(Orphan) 브라우저 프로세스 정리 ──
  // (서버가 강제 종료되었을 때 크롬 프로세스가 남아 프로필 디렉토리를 락킹하는 문제 방지)
  try {
    const { execSync } = require('child_process');
    // 해당 프로필 디렉토리를 사용하는 프로세스만 선택적으로 종료
    execSync(`pkill -f "user-data-dir=${DEFAULT_PROFILE_DIR}"`);
    await sleep(500); // 프로세스 종료 대기
  } catch { /* 실행 중인 프로세스가 없거나 실패 시 무시 */ }

  const context = await chromium.launchPersistentContext(DEFAULT_PROFILE_DIR, {
    headless: process.env.HEADLESS === 'true',
    channel: 'chrome',
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
    ],
    viewport: { width: 1280, height: 800 },
    locale:   'ko-KR',
  });

  _context = context;
  const pages = context.pages();
  _page = pages.length > 0 ? pages[0] : await context.newPage();

  context.on('close', () => { _context = null; _page = null; });
  return { context: _context, page: _page };
}

// ── SPA 준비 대기 ────────────────────────────────────────────────────────────
async function waitForSpaReady(page, log) {
  const deadline = Date.now() + SPA_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const url = page.url();
    if (!url.includes('gemini.google.com')) {
      await sleep(POLL_MS);
      continue;
    }

    // 로그인 필요 감지
    try {
      const signInVisible = await page.evaluate(() => {
        return !!(
          document.querySelector('a[aria-label="로그인"]') ||
          document.querySelector('a[aria-label="Sign in"]')
        );
      });
      if (signInVisible) {
        throw new Error('Gemini 로그인이 필요합니다. UI의 "Gemini 연결" 탭에서 먼저 로그인해주세요.');
      }
    } catch (e) {
      if (String(e.message).includes('로그인')) throw e;
    }

    // 편집기 요소 탐색
    const found = await page.evaluate((selectors) => {
      for (const sel of selectors) {
        try {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            if (el.classList.contains('ql-clipboard') || el.closest?.('.ql-clipboard')) continue;
            if (!el.isContentEditable && el.tagName.toLowerCase() !== 'rich-textarea') continue;
            const rect = el.getBoundingClientRect();
            if (rect.width > 2 && rect.height > 2) return sel;
          }
        } catch { /* 다음 */ }
      }
      return null;
    }, COMPOSER_SELECTORS);

    if (found) {
      log?.(`SPA 준비 완료 — 편집기 발견: ${found}`);
      await sleep(HYDRATION_MS);
      return true;
    }

    await sleep(POLL_MS);
  }

  throw new Error(`Gemini SPA 준비 시간 초과 (${SPA_TIMEOUT_MS / 1000}초)`);
}

// ── 프롬프트 입력 (Playwright Native API 방식) ──────
async function fillPrompt(page, promptText, log) {
  log?.(`프롬프트 입력 시도... (${promptText.length}자)`);

  let editorLocator = null;

  // 1. 입력 필드 찾기
  for (const sel of COMPOSER_SELECTORS) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 500 })) {
        editorLocator = loc;
        break;
      }
    } catch { /* ignore */ }
  }

  if (!editorLocator) {
    throw new Error('프롬프트 입력 실패: 편집기를 찾을 수 없습니다.');
  }

  // 2. 포커스 및 기존 텍스트 지우기
  await editorLocator.click();
  // Mac용 (Meta+A) 및 Windows용 (Control+A) 모두 실행
  await page.keyboard.press('Meta+A');
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');

  // 3. 네이티브 insertText로 전체 텍스트 한 번에 삽입 (줄바꿈/한글 완벽 지원)
  await page.keyboard.insertText(promptText);

  // 4. 입력 검증
  const got = await editorLocator.innerText();
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const wantNorm = norm(promptText);
  
  if (norm(got).length < Math.min(10, wantNorm.length)) {
    throw new Error(`프롬프트 입력 검증 실패 (샘플: "${got.slice(0, 50)}")`);
  }

  log?.(`✓ 프롬프트 입력 완료 (via: playwright_insertText)`);
  await sleep(400);
}

// ── 전송 버튼 클릭 (references/gemini_compose.js clickSendInPage 패턴) ────────
async function clickSend(page, log) {
  log?.('전송 시도...');

  // DOM 내부에서 Enter 키 이벤트 + 버튼 클릭 시도
  const sent = await page.evaluate(({ composerSelectors, sendSelectors }) => {
    // 편집기 포커스 후 Enter 키 이벤트 디스패치
    function pickEditor() {
      for (const sel of composerSelectors) {
        try {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            if (el.classList.contains('ql-clipboard') || el.closest?.('.ql-clipboard')) continue;
            if (!el.isContentEditable && el.tagName.toLowerCase() !== 'rich-textarea') continue;
            const rect = el.getBoundingClientRect();
            if (rect.width > 2 && rect.height > 2) return el;
          }
        } catch { /* 다음 */ }
      }
      return null;
    }

    const editor = pickEditor();
    if (editor) {
      editor.focus();
      const evOpts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      editor.dispatchEvent(new KeyboardEvent('keydown',  evOpts));
      editor.dispatchEvent(new KeyboardEvent('keypress', evOpts));
      editor.dispatchEvent(new KeyboardEvent('keyup',    evOpts));
      return { ok: true, via: 'enter_key' };
    }

    // 전송 버튼 직접 클릭
    for (const sel of sendSelectors) {
      const btn = document.querySelector(sel);
      if (!btn) continue;
      if (btn.getAttribute('aria-disabled') === 'true') continue;
      const rect = btn.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      btn.focus();
      btn.click();
      return { ok: true, via: 'button_click', selector: sel };
    }

    return { ok: false };
  }, { composerSelectors: COMPOSER_SELECTORS, sendSelectors: SEND_BTN_SELECTORS });

  if (sent.ok) {
    log?.(`✓ 전송 완료 (via: ${sent.via})`);
    return;
  }

  // 폴백: Playwright locator 클릭
  for (const sel of SEND_BTN_SELECTORS) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1000 })) {
        await btn.click({ timeout: 5000 });
        log?.(`✓ 전송 완료 (via: playwright locator, selector: ${sel})`);
        return;
      }
    } catch { /* 다음 */ }
  }

  // 최후 수단: Enter 키
  log?.('⚠ 전송 버튼 미발견 — keyboard.press Enter 시도');
  await page.keyboard.press('Enter');
}

// ── 생성 중 감지 ─────────────────────────────────────────────────────────────
async function isStillGenerating(page) {
  try {
    return await page.evaluate((patternSrc) => {
      const pattern = new RegExp(patternSrc, 'i');
      for (const frame of [document]) {
        const nodes = frame.querySelectorAll('button[aria-label], button[mattooltip]');
        for (const el of nodes) {
          const label = [
            el.getAttribute('aria-label'),
            el.getAttribute('mattooltip'),
          ].filter(Boolean).join(' ');
          if (!pattern.test(label)) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width > 2 && rect.height > 2) return true;
        }
      }
      return false;
    }, GENERATING_PATTERN.source);
  } catch {
    return false;
  }
}

// ── 응답 대기 ──────────────────────────────────────────────────────────────
/**
 * 전송 직후 응답 DOM 요소 수를 기록해 두고,
 * 새 model-response가 생기거나 생성 중 버튼이 사라지면 완료로 판단.
 */
async function waitForResponse(page, log) {
  // 전송 전 기존 응답 개수 기록
  const initialCount = await page.evaluate((selectors) => {
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      if (els.length > 0) return els.length;
    }
    return 0;
  }, RESPONSE_SELECTORS).catch(() => 0);

  log?.(`응답 대기 시작 (기존 응답 수: ${initialCount})`);

  // ── Phase 1: 생성 시작 또는 새 응답 요소 감지 (최대 20초) ──
  const phase1Deadline = Date.now() + 20_000;
  let generatingDetected = false;
  while (Date.now() < phase1Deadline) {
    const still = await isStillGenerating(page);
    if (still) { generatingDetected = true; break; }

    // 생성 중 버튼 없이 응답이 바로 추가된 경우도 처리
    const curCount = await page.evaluate((selectors) => {
      for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) return els.length;
      }
      return 0;
    }, RESPONSE_SELECTORS).catch(() => 0);
    if (curCount > initialCount) { generatingDetected = true; break; }

    await sleep(400);
  }

  if (generatingDetected) {
    log?.('Gemini 응답 생성 시작 감지');
  } else {
    log?.('⚠ 생성 시작 감지 실패 — 응답 추출 시도');
    await sleep(2000);
    return; // 그냥 진행
  }

  // ── Phase 2: 생성 완료까지 대기 ──
  const deadline = Date.now() + RESPONSE_TIMEOUT;
  let lastLog = 0;
  while (Date.now() < deadline) {
    const still = await isStillGenerating(page);
    if (!still) break;
    if (Date.now() - lastLog > 8_000) {
      log?.('Gemini 응답 생성 중... (대기)');
      lastLog = Date.now();
    }
    await sleep(POLL_MS);
  }

  await sleep(1500); // 렌더링 안정화
  log?.('응답 생성 완료');
}

// ── 응답 텍스트 추출 (references/gemini_compose.js 패턴) ─────────────────────
async function extractResponseText(page, log) {
  // 방법 1: copy-button locator → 버튼 주변 DOM에서 응답 추출
  log?.('응답 추출 시도...');

  for (const frame of page.frames()) {
    for (const sel of COPY_BTN_SELECTORS) {
      try {
        const btns = frame.locator(sel);
        const count = await btns.count();
        if (count === 0) continue;

        for (let i = count - 1; i >= 0; i--) {
          const btn = btns.nth(i);
          if (!(await btn.isVisible({ timeout: 300 }).catch(() => false))) continue;

          const aria = (await btn.getAttribute('aria-label').catch(() => '')) || '';
          const tip  = (await btn.getAttribute('mattooltip').catch(() => '')) || '';
          const combined = (aria + ' ' + tip).toLowerCase();
          // 코드블록 복사 버튼 제외
          if (combined.includes('코드') || combined.includes('code')) continue;

          // 버튼 주변 DOM에서 응답 텍스트 추출
          const text = await btn.evaluate((btnEl) => {
            function clean(t) { return String(t || '').replace(/\u200b/g, '').trim(); }
            const responseSelectors = [
              '[data-test-id="model-response"]',
              '[data-test-id="message-content"]',
              'model-response',
              '.model-response-text',
              'message-content',
            ];
            for (const s of responseSelectors) {
              try {
                const root = btnEl.closest(s);
                if (root) {
                  const t = clean(root.innerText);
                  if (t.length >= 10) return t;
                }
              } catch { /* ignore */ }
            }
            // 버튼 부모 요소에서 탐색
            const footer = btnEl.closest('message-actions') ||
                           btnEl.closest("[class*='message-footer']") ||
                           btnEl.closest("[class*='response-footer']");
            const parent = footer?.parentElement;
            if (parent) {
              const children = Array.from(parent.children);
              const idx = children.findIndex((c) => c.contains(btnEl));
              for (let j = idx - 1; j >= 0; j--) {
                const t = clean(children[j].innerText);
                if (t.length >= 20) return t;
              }
              const whole = clean(parent.innerText);
              if (whole.length >= 20) return whole;
            }
            // 상위 부모 탐색 (최대 28단계)
            let el = btnEl;
            let best = '';
            for (let d = 0; d < 28; d++) {
              el = el.parentElement;
              if (!el || el === document.body) break;
              const t = clean(el.innerText);
              if (t.length > best.length && t.length <= 400000) best = t;
            }
            return best;
          }).catch(() => '');

          if (text && text.length >= 10) {
            log?.(`응답 추출 성공 (copy-btn DOM, ${text.length}자, selector: ${sel})`);
            return text.trim();
          }
        }
      } catch { /* 다음 */ }
    }
  }

  // 방법 2: model-response locator 직접 텍스트 추출
  log?.('응답 추출 방법 2 시도 (model-response locator)...');
  for (const sel of RESPONSE_SELECTORS) {
    try {
      const els = page.locator(sel);
      const count = await els.count();
      if (count === 0) continue;
      const last = els.nth(count - 1);
      if (!(await last.isVisible({ timeout: 500 }).catch(() => false))) continue;
      const text = ((await last.innerText()) || '').replace(/\u200b/g, '').trim();
      if (text.length >= 10) {
        log?.(`응답 추출 성공 (model-response locator, ${text.length}자)`);
        return text;
      }
    } catch { /* 다음 */ }
  }

  // 방법 3: 페이지 전체 evaluate
  log?.('응답 추출 방법 3 시도 (page evaluate)...');
  try {
    const text = await page.evaluate((selectors) => {
      function clean(t) { return String(t || '').replace(/\u200b/g, '').trim(); }
      for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        if (!els.length) continue;
        const last = els[els.length - 1];
        const t = clean(last.innerText || last.textContent);
        if (t.length >= 10) return t;
      }
      return '';
    }, RESPONSE_SELECTORS);

    if (text && text.length >= 10) {
      log?.(`응답 추출 성공 (page evaluate, ${text.length}자)`);
      return text;
    }
  } catch { /* ignore */ }

  throw new Error('Gemini 응답 텍스트를 추출하지 못했습니다. 로그인 상태와 Gemini 페이지를 확인해주세요.');
}

// ── 메인 공개 함수: Gemini에 질문하고 응답 반환 ──────────────────────────────
async function askGemini(promptText, options = {}) {
  const { newChat = true, log } = options;

  const { page } = await getOrCreateContext();

  // 새 채팅: /app URL로 이동
  if (newChat) {
    log?.(`새 채팅 시작 → Gemini /app 이동 중...`);
    await page.goto(GEMINI_APP_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await sleep(3_000);
  }

  // SPA 준비 대기
  await waitForSpaReady(page, log);

  // 프롬프트 입력 (DOM execCommand 방식)
  await fillPrompt(page, promptText, log);

  // 잠깐 대기 후 전송
  await sleep(600);
  await clickSend(page, log);

  // 응답 대기
  await waitForResponse(page, log);

  // 응답 추출
  const response = await extractResponseText(page, log);
  return response;
}

// ── 외부 컨텍스트 주입 (session_manager에서 열린 브라우저 재사용) ─────────────
function setExternalContext(context, page) {
  _context = context;
  _page    = page;
}

async function closeAgent() {
  try { await _context?.close(); } catch { /* ignore */ }
  _context = null;
  _page    = null;
}

module.exports = {
  askGemini,
  setExternalContext,
  closeAgent,
  getOrCreateContext,
};
