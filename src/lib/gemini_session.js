'use strict';

/**
 * @file gemini_session.js
 * @description Gemini 세션 정보 읽기/쓰기 (파일 기반)
 * @purpose  현재 Gemini 로그인 세션 상태(프로필 경로, 토픽 등)를 JSON 파일로 저장하고
 *           불러오는 유틸리티. 세션 재활용 시 재로그인 없이 연속 작업 가능.
 * @exports  loadSession, saveSession, clearSession
 * @seeAlso  gemini_session_host.js, gemini_session_verify_host.js
 */


const fs = require('fs');
const path = require('path');

/** Root domains collected for Google/Gemini session bridging (see jably bg-incognito-lab.js). */
const GEMINI_COOKIE_DOMAINS = ['google.com', 'googleapis.com', 'youtube.com'];

const GOOGLE_AUTH_COOKIE_NAMES = new Set([
  'SID',
  'SSID',
  'HSID',
  'APISID',
  'SAPISID',
  '__Secure-1PSID',
  '__Secure-3PSID',
  '__Secure-1PAPISID',
  '__Secure-3PAPISID',
]);

function cookieMatchesDomains(cookieDomain, roots = GEMINI_COOKIE_DOMAINS) {
  const normalized = String(cookieDomain || '')
    .replace(/^\./, '')
    .toLowerCase();
  if (!normalized) {
    return false;
  }

  return roots.some((root) => normalized === root || normalized.endsWith(`.${root}`));
}

function buildCookieUrl(row, fallbackProtocol = 'https:') {
  const protocol = row.secure ? 'https:' : fallbackProtocol;
  const domain = String(row.domain || 'google.com');
  const host = domain.startsWith('.') ? domain.slice(1) : domain;
  const cookiePath = row.path && row.path.startsWith('/') ? row.path : '/';
  return `${protocol}//${host}${cookiePath}`;
}

function serializePlaywrightCookie(cookie) {
  /** @type {Record<string, unknown>} */
  const out = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || '/',
    secure: !!cookie.secure,
    httpOnly: !!cookie.httpOnly,
  };

  if (cookie.sameSite) {
    out.sameSite = cookie.sameSite;
  }
  if (cookie.expires != null && cookie.expires >= 0) {
    out.expires = cookie.expires;
  }
  if (cookie.partitionKey) {
    out.partitionKey = cookie.partitionKey;
  }

  return out;
}

function normalizeSameSite(value) {
  if (!value) {
    return undefined;
  }
  const text = String(value);
  if (text === 'Strict' || text === 'Lax' || text === 'None') {
    return text;
  }
  const lower = text.toLowerCase();
  if (lower === 'strict') {
    return 'Strict';
  }
  if (lower === 'lax') {
    return 'Lax';
  }
  if (lower === 'none') {
    return 'None';
  }
  return undefined;
}

function toPlaywrightAddCookie(row) {
  if (!row || typeof row.name !== 'string' || row.value == null) {
    const err = new Error('invalid_cookie_row');
    err.code = 'invalid_cookie_row';
    throw err;
  }

  const isHostPrefixed = row.name.startsWith('__Host-');
  const isSecurePrefixed = row.name.startsWith('__Secure-');
  const expires = row.expires != null ? row.expires : row.expirationDate;

  /** @type {import('playwright').Cookie} */
  const cookie = {
    name: row.name,
    value: String(row.value),
    httpOnly: !!row.httpOnly,
    secure: isHostPrefixed || isSecurePrefixed ? true : !!row.secure,
  };

  const sameSite = normalizeSameSite(row.sameSite);
  if (sameSite) {
    cookie.sameSite = sameSite;
  }

  if (expires != null && expires >= 0) {
    cookie.expires = expires;
  }

  if (row.partitionKey) {
    cookie.partitionKey = row.partitionKey;
  }

  if (isHostPrefixed) {
    cookie.url = buildCookieUrl(row);
    return cookie;
  }

  const domain = String(row.domain || '').trim();
  if (domain) {
    cookie.domain = domain;
    cookie.path = row.path && row.path.startsWith('/') ? row.path : '/';
    return cookie;
  }

  cookie.url = buildCookieUrl(row);
  return cookie;
}

function isValidSnapshot(snapshot) {
  return (
    snapshot &&
    typeof snapshot === 'object' &&
    snapshot.version === 1 &&
    Array.isArray(snapshot.cookies) &&
    snapshot.cookies.length > 0
  );
}

function snapshotHasAuthCookies(snapshot) {
  return snapshot.cookies.some(
    (row) => row && GOOGLE_AUTH_COOKIE_NAMES.has(row.name) && row.value,
  );
}

/**
 * Collect Google/Gemini cookies from a Playwright browser context.
 * @param {import('playwright').BrowserContext} context
 * @param {{ domains?: string[]; profileDir?: string; source?: string }} [options]
 */
async function exportCookies(context, options = {}) {
  const domains = options.domains || GEMINI_COOKIE_DOMAINS;
  const allCookies = await context.cookies();
  const filtered = allCookies.filter((cookie) => cookieMatchesDomains(cookie.domain, domains));

  if (filtered.length === 0) {
    const err = new Error('cookies_empty');
    err.code = 'cookies_empty';
    throw err;
  }

  return {
    version: 1,
    savedAt: Date.now(),
    source: options.source || 'playwright',
    profileDir: options.profileDir || null,
    domains: [...domains],
    cookies: filtered.map(serializePlaywrightCookie),
  };
}

/**
 * Inject snapshot cookies into a Playwright browser context.
 * @param {import('playwright').BrowserContext} context
 * @param {object} snapshot
 */
async function importCookies(context, snapshot) {
  if (!isValidSnapshot(snapshot)) {
    const err = new Error('invalid_snapshot');
    err.code = 'invalid_snapshot';
    throw err;
  }

  const cookies = snapshot.cookies.map(toPlaywrightAddCookie);
  /** @type {string[]} */
  const failed = [];
  let copied = 0;

  try {
    await context.addCookies(cookies);
    copied = cookies.length;
  } catch (batchError) {
    for (const cookie of cookies) {
      try {
        await context.addCookies([cookie]);
        copied += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failed.push(`${cookie.name}@${cookie.domain || cookie.url}: ${msg}`);
      }
    }

    if (copied === 0) {
      const err = new Error(batchError instanceof Error ? batchError.message : String(batchError));
      err.code = 'cookies_import_failed';
      err.failed = failed;
      throw err;
    }
  }

  return {
    total: cookies.length,
    copied,
    failed,
    hasAuthCookies: snapshotHasAuthCookies(snapshot),
  };
}

function resolveCookieFilePath(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
}

function writeSnapshotFile(filePath, snapshot) {
  const resolved = resolveCookieFilePath(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  return resolved;
}

function readSnapshotFile(filePath) {
  const resolved = resolveCookieFilePath(filePath);
  if (!fs.existsSync(resolved)) {
    const err = new Error(`snapshot_not_found: ${resolved}`);
    err.code = 'snapshot_not_found';
    throw err;
  }

  const raw = fs.readFileSync(resolved, 'utf8');
  return JSON.parse(raw);
}

function logSessionEvent(logger, event, payload) {
  logger.info(`[Gemini] [SESSION] ${event} ${JSON.stringify(payload)}`);
}

module.exports = {
  GEMINI_COOKIE_DOMAINS,
  GOOGLE_AUTH_COOKIE_NAMES,
  exportCookies,
  importCookies,
  isValidSnapshot,
  snapshotHasAuthCookies,
  cookieMatchesDomains,
  toPlaywrightAddCookie,
  writeSnapshotFile,
  readSnapshotFile,
  logSessionEvent,
};
