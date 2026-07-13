'use strict';

/**
 * @file server_api.js
 * @description 원격 서버 API 연동 (프롬프트 템플릿 & 셀렉터 동기화)
 * @purpose  Firebase Cloud Functions에서 Gemini 프롬프트 템플릿 및 DOM 셀렉터를
 *           원격으로 가져오는 API 클라이언트. 로컬 파일보다 항상 우선 적용됨.
 * @exports  fetchPromptTemplate, fetchSelectors, resolveIdToken, DEFAULT_TOKEN_FILE
 * @seeAlso  prompt_cache.js, gemini_common.js
 */


const fs = require('fs');
const path = require('path');

const CLOUD_FUNCTIONS_REGION = 'asia-northeast3';
const FIREBASE_PROJECT_ID = 'jably-9369d';
const FUNCTIONS_BASE_URL = `https://${CLOUD_FUNCTIONS_REGION}-${FIREBASE_PROJECT_ID}.cloudfunctions.net`;

const DEFAULT_TOKEN_FILE = path.resolve(process.cwd(), 'build', 'firebase-token.json');

/**
 * Read Firebase ID token from env or Flutter-written token file.
 * @param {{ tokenFile?: string, logger?: object }} [options]
 * @returns {string|null}
 */
function resolveIdToken(options = {}) {
  const fromEnv = String(process.env.JABLY_ID_TOKEN || '').trim();
  if (fromEnv) {
    return fromEnv;
  }

  const tokenPath = path.resolve(
    options.tokenFile ||
      process.env.JABLY_TOKEN_FILE ||
      DEFAULT_TOKEN_FILE,
  );

  if (!fs.existsSync(tokenPath)) {
    return null;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    if (typeof raw === 'string' && raw.trim()) {
      return raw.trim();
    }
    if (typeof raw?.idToken === 'string' && raw.idToken.trim()) {
      return raw.idToken.trim();
    }
    if (typeof raw?.accessToken === 'string' && raw.accessToken.trim()) {
      return raw.accessToken.trim();
    }
    if (typeof raw?.stsTokenManager?.accessToken === 'string') {
      return raw.stsTokenManager.accessToken.trim();
    }
  } catch (error) {
    options.logger?.info?.(
      `[ServerAPI] token file read failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return null;
}

/**
 * @param {string} name
 * @param {object} data
 * @param {{ tokenFile?: string, logger?: object }} [options]
 * @returns {Promise<any>}
 */
async function callFunction(name, data, options = {}) {
  const token = resolveIdToken(options);
  if (!token) {
    throw new Error('No Firebase auth token available');
  }

  const url = `${FUNCTIONS_BASE_URL}/${name}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ data }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Cloud Function ${name} failed: ${res.status} ${text}`);
  }

  const json = await res.json();
  return json.result;
}

/**
 * Fetch assembled prompt from getPrompt Cloud Function.
 * @param {'tistory'|'naver'} platform
 * @param {object|null|undefined} topicMeta
 * @param {{ tokenFile?: string, logger?: object }} [options]
 * @returns {Promise<string>}
 */
async function fetchPrompt(platform, topicMeta, options = {}) {
  const resolvedPlatform = platform === 'naver' ? 'naver' : 'tistory';
  const result = await callFunction(
    'getPrompt',
    { platform: resolvedPlatform, topicMeta: topicMeta ?? null },
    options,
  );
  return String(result?.prompt || result?.body || '').trim();
}

/**
 * Fetch template body + updatedAt (topicMeta=null).
 * @param {'tistory'|'naver'} platform
 * @param {{ tokenFile?: string, logger?: object }} [options]
 * @returns {Promise<{ body: string, updatedAt: string }>}
 */
async function fetchPromptTemplate(platform, options = {}) {
  const resolvedPlatform = platform === 'naver' ? 'naver' : 'tistory';
  const result = await callFunction(
    'getPrompt',
    { platform: resolvedPlatform, topicMeta: null },
    options,
  );
  const body = String(result?.body || result?.prompt || '').trim();
  const updatedAt = String(result?.updatedAt || '').trim();
  if (!body) {
    throw new Error(`getPrompt returned empty template for ${resolvedPlatform}`);
  }
  return { body, updatedAt };
}

/**
 * Fetch DOM selectors from getSelectors Cloud Function.
 * @param {string[]} [platforms]
 * @param {{ tokenFile?: string, logger?: object }} [options]
 * @returns {Promise<{ selectors: Record<string, object>, meta: Record<string, { updatedAt?: string }> }>}
 */
async function fetchSelectors(platforms, options = {}) {
  const resolvedPlatforms =
    Array.isArray(platforms) && platforms.length
      ? platforms
      : ['tistory', 'naver', 'gemini', 'google'];
  const result = await callFunction('getSelectors', { platforms: resolvedPlatforms }, options);
  const selectors = result?.selectors;
  if (!selectors || typeof selectors !== 'object') {
    throw new Error('getSelectors returned empty payload');
  }
  const meta = result?.meta && typeof result.meta === 'object' ? result.meta : {};
  return { selectors, meta };
}

module.exports = {
  CLOUD_FUNCTIONS_REGION,
  FIREBASE_PROJECT_ID,
  FUNCTIONS_BASE_URL,
  DEFAULT_TOKEN_FILE,
  resolveIdToken,
  callFunction,
  fetchPrompt,
  fetchPromptTemplate,
  fetchSelectors,
};
