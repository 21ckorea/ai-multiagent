'use strict';

/**
 * @file tistory_common.js
 * @description 티스토리 공통 유틸리티 (URL 판별, 상수)
 * @purpose  티스토리 URL 패턴 매칭(isOnTistoryNewPost, isOnTistorySite),
 *           블로그 호스트 파싱 등 티스토리 관련 공통 헬퍼 모음.
 * @exports  isOnTistoryNewPost, isOnTistorySite, parseUrlHostname, ...
 * @seeAlso  tistory_editor_inject.js, playwright_tistory_login.js
 */


const path = require('path');
const minimist = require('minimist');
const {
  harvestCategories,
  logCategoriesJsonLines,
  CATEGORY_HARVEST_POLL_MS,
  CATEGORY_HARVEST_MAX_POLLS,
  CATEGORY_SELECTORS,
} = require('./tistory_category_harvest');

/** Same entry URL as jably_blog/lib/bg-constants.js (OAuth continue; may expire). */
const TISTORY_KAKAO_LOGIN_URL =
  'https://accounts.kakao.com/login/?continue=https%3A%2F%2Fkauth.kakao.com%2Foauth%2Fauthorize%3Fclient_id%3D3e6ddd834b023f24221217e370daed18%26state%3DaHR0cHM6Ly93d3cudGlzdG9yeS5jb20v%26redirect_uri%3Dhttps%253A%252F%252Fwww.tistory.com%252Fauth%252Fkakao%252Fredirect%26response_type%3Dcode%26auth_tran_id%3DucCs_~xMqpNsQYi4gxY1drUGrLnokMUPkolWZTYFqeM-teL3lAC-1Mx_uROA%26ka%3Dsdk%252F2.7.3%2520os%252Fjavascript%2520sdk_type%252Fjavascript%2520lang%252Fko-KR%2520device%252FWin32%2520origin%252Fhttps%25253A%25252F%25252Fwww.tistory.com%26is_popup%3Dfalse%26through_account%3Dtrue&talk_login=hidden#login';

/** Legacy bg-constants.js / parseTistoryArgs fallback when batch JSON omits kakaoLoginUrl. */
function resolveKakaoLoginUrl(value) {
  const trimmed = String(value || '').trim();
  return trimmed || TISTORY_KAKAO_LOGIN_URL;
}

const DEFAULT_TISTORY_PROFILE_DIR = 'profiles/playwright-tistory-profile';
const DEFAULT_SELENIUM_TISTORY_PROFILE_DIR = 'profiles/selenium-tistory-profile';
const TISTORY_LOGIN_TIMEOUT_MS = 2 * 60 * 1000;
const TISTORY_URL_POLL_INTERVAL_MS = 2000;
const TISTORY_PAGE_LOAD_TIMEOUT_MS = 60 * 1000;

const TISTORY_MODES = ['publish', 'verify', 'refresh'];

/** Standard failure reason codes (extension parity + ja_test E2E). */
const TISTORY_ERROR = {
  MISSING_CREDENTIALS: 'missing_credentials',
  INVALID_BLOG_URL: 'invalid_blog_url',
  KAKAO_LOGIN_ERROR: 'kakao_login_error',
  KAKAO_LOGIN_TIMEOUT: 'kakao_login_timeout',
  CATEGORY_LIST_TIMEOUT: 'category_list_timeout',
  SESSION_EXPIRED: 'session_expired',
};

function normalizeFailureReason(reason) {
  switch (reason) {
    case 'missing_blog_url':
    case 'wrong_blog_hostname':
      return TISTORY_ERROR.INVALID_BLOG_URL;
    case 'login_timeout':
      return TISTORY_ERROR.KAKAO_LOGIN_TIMEOUT;
    case 'no_category_btn':
    case 'category_btn_click':
    case 'empty_category_list':
    case 'no_categories':
    case 'category_list_timeout':
      return TISTORY_ERROR.CATEGORY_LIST_TIMEOUT;
    case TISTORY_ERROR.MISSING_CREDENTIALS:
    case TISTORY_ERROR.INVALID_BLOG_URL:
    case TISTORY_ERROR.KAKAO_LOGIN_ERROR:
    case TISTORY_ERROR.KAKAO_LOGIN_TIMEOUT:
    case TISTORY_ERROR.SESSION_EXPIRED:
      return reason;
    default:
      return reason;
  }
}

function parseTistoryArgs() {
  const args = minimist(process.argv.slice(2), {
    boolean: ['headless'],
    string: [
      'blog-url',
      'blogUrl',
      'kakao-id',
      'kakaoId',
      'kakao-password',
      'kakaoPassword',
      'kakao-login-url',
      'kakaoLoginUrl',
      'profile-dir',
      'profileDir',
      'mode',
    ],
    default: { mode: 'publish', headless: false },
  });

  const modeRaw = (args.mode || 'publish').toLowerCase();
  const mode = TISTORY_MODES.includes(modeRaw) ? modeRaw : 'publish';

  const profileDirRaw = (args['profile-dir'] || args.profileDir || DEFAULT_TISTORY_PROFILE_DIR).trim();
  const kakaoLoginUrlRaw = resolveKakaoLoginUrl(args['kakao-login-url'] || args.kakaoLoginUrl);

  return {
    blogUrl: (args['blog-url'] || args.blogUrl || '').trim(),
    kakaoId: (args['kakao-id'] || args.kakaoId || '').trim(),
    kakaoPassword: args['kakao-password'] || args.kakaoPassword || '',
    kakaoLoginUrl: kakaoLoginUrlRaw,
    profileDir: path.resolve(process.cwd(), profileDirRaw),
    mode,
    headless: args.headless === true,
  };
}

function buildNewPostUrl(raw) {
  let u = (raw || '').trim();
  if (!u) {
    return '';
  }
  if (!/^https?:\/\//i.test(u)) {
    u = `https://${u}`;
  }
  u = u.replace(/\/+$/, '');
  return `${u}/manage/newpost`;
}

function sameBlogHostname(pageUrl, expectedNewPostUrl) {
  try {
    const h1 = new URL(pageUrl).hostname.toLowerCase();
    const h2 = new URL(expectedNewPostUrl).hostname.toLowerCase();
    return h1 === h2;
  } catch {
    return false;
  }
}

function validateTistoryArgs({ blogUrl, kakaoId, kakaoPassword, mode }) {
  if (!blogUrl) {
    return { ok: false, reason: TISTORY_ERROR.INVALID_BLOG_URL };
  }

  const newPostUrl = buildNewPostUrl(blogUrl);
  if (!newPostUrl) {
    return { ok: false, reason: TISTORY_ERROR.INVALID_BLOG_URL };
  }

  if (mode === 'publish' || mode === 'verify') {
    if (!kakaoId || !kakaoPassword) {
      return { ok: false, reason: TISTORY_ERROR.MISSING_CREDENTIALS };
    }
  }

  return { ok: true, newPostUrl };
}

function harvestFailureReason(harvest) {
  if (!harvest?.ok) {
    return normalizeFailureReason(harvest?.error || 'no_categories');
  }
  if (!Array.isArray(harvest.items) || harvest.items.length === 0) {
    return TISTORY_ERROR.CATEGORY_LIST_TIMEOUT;
  }
  return null;
}

function isOnTistoryNewPost(url) {
  const host = parseUrlHostname(url);
  return /(?:^|\.)tistory\.com$/i.test(host) && /\/manage\/newpost/i.test(url);
}

function parseUrlHostname(url) {
  if (typeof url === 'string' && url.trim()) {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      // fall through
    }
  }
  return '';
}

function isOnKakaoLogin(url) {
  const host = parseUrlHostname(url);
  return host === 'accounts.kakao.com' || host.endsWith('.accounts.kakao.com');
}

function isOnKakaoOAuth(url) {
  const host = parseUrlHostname(url);
  return host === 'kauth.kakao.com' || host.endsWith('.kauth.kakao.com');
}

function isOnTistorySite(url) {
  const host = parseUrlHostname(url);
  return /(?:^|\.)tistory\.com$/i.test(host);
}

/** refresh mode: Kakao/Tistory login redirect means stored session is gone. */
function isSessionExpiredRedirect(url) {
  if (typeof url !== 'string' || !url.trim()) {
    return false;
  }
  if (isOnKakaoLogin(url) || isOnKakaoOAuth(url)) {
    return true;
  }
  const host = parseUrlHostname(url);
  if (/(?:^|\.)tistory\.com$/i.test(host) && (/\/auth\b/i.test(url) || /\/login\b/i.test(url))) {
    return true;
  }
  return false;
}

/** @deprecated Use logCategoriesJsonLines from tistory_category_harvest.js */
function logCategoriesPayload(logger, harvest) {
  logCategoriesJsonLines(logger, harvest);
}

/** Phase 9 handoff — login success → editor prefill entry (Phase 10 consumer). */
function logHandoffJsonLine(logger, payload) {
  const body = {
    newPostUrl: payload?.newPostUrl || '',
    finalUrl: payload?.finalUrl || '',
    profileDir: payload?.profileDir || '',
  };
  logger.info(`[Tistory] [HANDOFF] ${JSON.stringify(body)}`);
}

module.exports = {
  TISTORY_ERROR,
  normalizeFailureReason,
  harvestFailureReason,
  TISTORY_KAKAO_LOGIN_URL,
  resolveKakaoLoginUrl,
  DEFAULT_TISTORY_PROFILE_DIR,
  DEFAULT_SELENIUM_TISTORY_PROFILE_DIR,
  TISTORY_LOGIN_TIMEOUT_MS,
  TISTORY_URL_POLL_INTERVAL_MS,
  TISTORY_PAGE_LOAD_TIMEOUT_MS,
  CATEGORY_HARVEST_POLL_MS,
  CATEGORY_HARVEST_MAX_POLLS,
  CATEGORY_SELECTORS,
  TISTORY_MODES,
  parseTistoryArgs,
  buildNewPostUrl,
  sameBlogHostname,
  validateTistoryArgs,
  isOnTistoryNewPost,
  parseUrlHostname,
  isOnKakaoLogin,
  isOnTistorySite,
  isSessionExpiredRedirect,
  harvestCategories,
  logCategoriesJsonLines,
  logCategoriesPayload,
  logHandoffJsonLine,
};
