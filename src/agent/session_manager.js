'use strict';

/**
 * @file session_manager.js
 * @description Playwright 퍼시스턴트 컨텍스트 기반 Gemini 세션 관리
 */

const path = require('path');
const fs = require('fs');

const DEFAULT_GEMINI_URL = 'https://gemini.google.com/app';
const DEFAULT_PROFILE_DIR = path.resolve(process.cwd(), 'profiles', 'gemini-profile');
const SESSION_INFO_FILE = path.resolve(process.cwd(), 'data', 'sessions', 'session_info.json');

const GEMINI_SIGNED_IN_SELECTORS = [
  'img[src*="googleusercontent.com/a/"]',
  'img[alt*="Profile" i]',
  'img[alt*="프로필"]',
  'gb-avatar',
];

const GEMINI_SIGN_IN_REQUIRED_SELECTORS = [
  'a[aria-label="로그인"]',
  'a.gb_0a.gb_2d',
  'a[href*="accounts.google.com/ServiceLogin"]',
];

const NEW_CHAT_SELECTORS = [
  'button[aria-label*="새 채팅"]',
  'button[aria-label*="New chat"]',
  'a[href="/app"]',
  '[data-test-id="new-chat-button"]',
];

let _browser = null;
let _context = null;
let _page = null;

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readSessionInfo() {
  try {
    if (fs.existsSync(SESSION_INFO_FILE)) {
      return JSON.parse(fs.readFileSync(SESSION_INFO_FILE, 'utf8'));
    }
  } catch { /* ignore */ }
  return null;
}

function writeSessionInfo(info) {
  ensureDir(SESSION_INFO_FILE);
  fs.writeFileSync(SESSION_INFO_FILE, JSON.stringify(info, null, 2), 'utf8');
}

function clearSessionInfo() {
  try {
    if (fs.existsSync(SESSION_INFO_FILE)) {
      fs.unlinkSync(SESSION_INFO_FILE);
    }
  } catch { /* ignore */ }
}

/**
 * 퍼시스턴트 컨텍스트로 브라우저 실행
 */
async function launchBrowser(profileDir = DEFAULT_PROFILE_DIR) {
  const { chromium } = require('playwright');
  fs.mkdirSync(profileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
    ],
    viewport: { width: 1280, height: 800 },
    locale: 'ko-KR',
  });

  _context = context;
  const pages = context.pages();
  _page = pages.length > 0 ? pages[0] : await context.newPage();
  return { context, page: _page };
}

/**
 * Gemini 로그인 상태 확인
 */
async function checkLoginStatus(page) {
  try {
    const url = page.url();
    if (!url.includes('gemini.google.com')) {
      await page.goto(DEFAULT_GEMINI_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);
    }

    for (const sel of GEMINI_SIGNED_IN_SELECTORS) {
      try {
        const el = await page.locator(sel).first();
        if (await el.isVisible({ timeout: 3000 })) {
          return { loggedIn: true, selector: sel };
        }
      } catch { /* try next */ }
    }

    for (const sel of GEMINI_SIGN_IN_REQUIRED_SELECTORS) {
      try {
        const el = await page.locator(sel).first();
        if (await el.isVisible({ timeout: 2000 })) {
          return { loggedIn: false, selector: sel };
        }
      } catch { /* try next */ }
    }

    return { loggedIn: false, selector: null };
  } catch (err) {
    return { loggedIn: false, error: err.message };
  }
}

/**
 * 세션 시작: 브라우저 열기 + Gemini 이동
 */
async function startSession(profileDir = DEFAULT_PROFILE_DIR) {
  if (_context) {
    return { ok: true, message: '이미 세션이 열려 있습니다.', alreadyOpen: true };
  }

  try {
    const { context, page } = await launchBrowser(profileDir);
    await page.goto(DEFAULT_GEMINI_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    const status = await checkLoginStatus(page);
    return { ok: true, loggedIn: status.loggedIn, page, context };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * 현재 열린 세션의 로그인 상태 확인 및 저장
 */
async function verifyAndSaveSession() {
  if (!_context || !_page) {
    return { ok: false, error: '브라우저가 열려있지 않습니다.' };
  }

  const status = await checkLoginStatus(_page);
  if (status.loggedIn) {
    const info = {
      loggedIn: true,
      savedAt: new Date().toISOString(),
      profileDir: DEFAULT_PROFILE_DIR,
      geminiUrl: DEFAULT_GEMINI_URL,
    };
    writeSessionInfo(info);
    return { ok: true, loggedIn: true, savedAt: info.savedAt };
  }

  return { ok: false, loggedIn: false, error: '로그인 상태가 확인되지 않았습니다.' };
}

/**
 * 세션 캐시 삭제 (session_info.json 및 프로파일 초기화)
 */
async function clearSession(clearProfile = false) {
  // 브라우저 종료
  await closeBrowser();

  // session_info.json 삭제
  clearSessionInfo();

  // 프로파일 폴더 삭제 (선택)
  if (clearProfile) {
    try {
      fs.rmSync(DEFAULT_PROFILE_DIR, { recursive: true, force: true });
    } catch { /* ignore */ }
  }

  return { ok: true };
}

/**
 * 브라우저 닫기
 */
async function closeBrowser() {
  try {
    if (_context) {
      await _context.close();
    }
  } catch { /* ignore */ }
  _browser = null;
  _context = null;
  _page = null;
}

/**
 * 저장된 세션 정보 반환
 */
function getSessionInfo() {
  return readSessionInfo();
}

/**
 * 현재 브라우저 상태
 */
function getBrowserState() {
  return {
    isOpen: !!_context,
    hasPage: !!_page,
  };
}

module.exports = {
  DEFAULT_PROFILE_DIR,
  DEFAULT_GEMINI_URL,
  startSession,
  verifyAndSaveSession,
  clearSession,
  closeBrowser,
  checkLoginStatus,
  getSessionInfo,
  getBrowserState,
};
