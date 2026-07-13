'use strict';

/**
 * @file prompt_cache.js
 * @description Gemini 프롬프트 템플릿 캐싱 레이어
 * @purpose  server_api.js를 통해 서버에서 받아온 프롬프트 템플릿을
 *           로컬 파일에 캐싱하여, 서버 불안정 시에도 안정적으로 사용할 수 있게 함.
 * @exports  ensureTemplate, ensurePromptTemplatesForBatch, assemblePrompt
 * @seeAlso  server_api.js, gemini_common.js
 */


const fs = require('fs');
const path = require('path');

const { formatGeminiDateKo, normalizeGeminiTopicSlot } = require('./gemini_common');
const { appendTopicToNaverPromptBase } = require('./gemini_naver_prompt');

const DEFAULT_CACHE_DIR = path.resolve(process.cwd(), 'build', 'prompt-cache');
/** Fallback safety net when updatedAt is missing from legacy cache files. */
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Resolve topic tail line (matches firebase/functions/src/prompt.ts resolveTopicLine).
 * @param {object|null|undefined} meta
 * @returns {string}
 */
function resolveTopicLine(meta) {
  if (!meta || typeof meta !== 'object') {
    return '';
  }

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
  return '';
}

/**
 * Assemble final Gemini prompt from cached template + per-slot topic meta.
 * @param {'tistory'|'naver'} platform
 * @param {string} templateBody
 * @param {object|null|undefined} topicMeta
 * @returns {string}
 */
function assemblePrompt(platform, templateBody, topicMeta) {
  const resolvedPlatform = platform === 'naver' ? 'naver' : 'tistory';
  const body = String(templateBody || '').trim();
  const topicLine = resolveTopicLine(topicMeta);

  if (resolvedPlatform === 'naver') {
    return appendTopicToNaverPromptBase(body, topicLine);
  }

  const tail = topicLine.replace(/\s+/g, ' ').trim();
  if (!tail) {
    return body;
  }
  return `${body} ${tail}`;
}

function resolveCacheDir(options = {}) {
  const override = String(options.cacheDir || process.env.JABLY_PROMPT_CACHE_DIR || '').trim();
  return override ? path.resolve(override) : DEFAULT_CACHE_DIR;
}

function cacheFilePath(platform, options = {}) {
  const resolvedPlatform = platform === 'naver' ? 'naver' : 'tistory';
  return path.join(resolveCacheDir(options), `${resolvedPlatform}.json`);
}

function readRawDiskCache(platform, options = {}) {
  const filePath = cacheFilePath(platform, options);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {'tistory'|'naver'} platform
 * @param {{ cacheDir?: string, maxAgeMs?: number }} [options]
 * @returns {{ body: string, updatedAt: string, source: 'disk_cache' }|null}
 */
function readDiskCache(platform, options = {}) {
  const raw = readRawDiskCache(platform, options);
  if (!raw) {
    return null;
  }

  const body = String(raw?.body || '').trim();
  if (!body) {
    return null;
  }

  const updatedAt = String(raw?.updatedAt || raw?.cachedAt || '').trim();
  if (!updatedAt) {
    const maxAgeMs =
      typeof options.maxAgeMs === 'number' && options.maxAgeMs > 0
        ? options.maxAgeMs
        : DEFAULT_MAX_AGE_MS;
    const ageMs = Date.now() - Date.parse(String(raw?.cachedAt || ''));
    if (!Number.isFinite(ageMs) || ageMs > maxAgeMs) {
      return null;
    }
    return { body, updatedAt: String(raw?.cachedAt || ''), source: 'disk_cache' };
  }

  return { body, updatedAt, source: 'disk_cache' };
}

/**
 * @param {'tistory'|'naver'} platform
 * @param {string} body
 * @param {{ cacheDir?: string, updatedAt?: string }} [options]
 */
function writeDiskCache(platform, body, options = {}) {
  const resolvedPlatform = platform === 'naver' ? 'naver' : 'tistory';
  const trimmed = String(body || '').trim();
  if (!trimmed) {
    throw new Error(`prompt cache write skipped: empty body for ${resolvedPlatform}`);
  }

  const updatedAt =
    String(options.updatedAt || '').trim() || new Date().toISOString();
  const filePath = cacheFilePath(resolvedPlatform, options);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      {
        platform: resolvedPlatform,
        body: trimmed,
        updatedAt,
      },
      null,
      2,
    ),
    'utf8',
  );
}

/**
 * Fetch template body + updatedAt from getPrompt (topicMeta=null).
 * @param {'tistory'|'naver'} platform
 * @param {{ tokenFile?: string, logger?: object }} [options]
 * @returns {Promise<{ body: string, updatedAt: string }>}
 */
async function fetchTemplateFromServer(platform, options = {}) {
  const { fetchPromptTemplate } = require('./server_api');
  return fetchPromptTemplate(platform, options);
}

/**
 * @param {string|null|undefined} localUpdatedAt
 * @param {string|null|undefined} serverUpdatedAt
 * @returns {boolean}
 */
function isUpdatedAtStale(localUpdatedAt, serverUpdatedAt) {
  const local = String(localUpdatedAt || '').trim();
  const server = String(serverUpdatedAt || '').trim();
  if (!server) {
    return true;
  }
  if (!local) {
    return true;
  }
  return local !== server;
}

/**
 * Sync disk cache when server updatedAt differs (login / explicit refresh).
 * @param {'tistory'|'naver'} platform
 * @param {{ tokenFile?: string, cacheDir?: string, logger?: object }} [options]
 * @returns {Promise<'skipped'|'updated'|'failed'>}
 */
async function syncTemplateIfNeeded(platform, options = {}, logger) {
  const resolvedPlatform = platform === 'naver' ? 'naver' : 'tistory';
  try {
    const local = readDiskCache(resolvedPlatform, options);
    const server = await fetchTemplateFromServer(resolvedPlatform, options);
    if (!isUpdatedAtStale(local?.updatedAt, server.updatedAt)) {
      logger?.info?.(
        `[PromptCache] sync skip platform=${resolvedPlatform} updatedAt=${server.updatedAt}`,
      );
      return 'skipped';
    }
    writeDiskCache(resolvedPlatform, server.body, {
      cacheDir: options.cacheDir,
      updatedAt: server.updatedAt,
    });
    logger?.info?.(
      `[PromptCache] sync updated platform=${resolvedPlatform} updatedAt=${server.updatedAt}`,
    );
    return 'updated';
  } catch (error) {
    logger?.info?.(
      `[PromptCache] sync failed platform=${resolvedPlatform}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 'failed';
  }
}

/**
 * Ensure platform template is available (memory → disk → server).
 * @param {'tistory'|'naver'} platform
 * @param {{ tokenFile?: string, promptTemplateCache?: Record<string, string>, cacheDir?: string, maxAgeMs?: number, logger?: object }} [options]
 * @param {object} [logger]
 * @returns {Promise<{ body: string, source: 'memory_cache'|'disk_cache'|'server' }>}
 */
async function ensureTemplate(platform, options = {}, logger) {
  const resolvedPlatform = platform === 'naver' ? 'naver' : 'tistory';
  const cache = options.promptTemplateCache;
  const memoryBody = cache && typeof cache[resolvedPlatform] === 'string' ? cache[resolvedPlatform].trim() : '';
  if (memoryBody) {
    logger?.info?.(`[PromptCache] hit memory platform=${resolvedPlatform} chars=${memoryBody.length}`);
    return { body: memoryBody, source: 'memory_cache' };
  }

  const diskHit = readDiskCache(resolvedPlatform, options);
  if (diskHit) {
    if (cache) {
      cache[resolvedPlatform] = diskHit.body;
    }
    logger?.info?.(
      `[PromptCache] hit disk platform=${resolvedPlatform} chars=${diskHit.body.length} updatedAt=${diskHit.updatedAt}`,
    );
    return { body: diskHit.body, source: 'disk_cache' };
  }

  const serverBody = await fetchTemplateFromServer(resolvedPlatform, {
    tokenFile: options.tokenFile,
    logger: options.logger || logger,
  });
  writeDiskCache(resolvedPlatform, serverBody.body, {
    cacheDir: options.cacheDir,
    updatedAt: serverBody.updatedAt,
  });
  if (cache) {
    cache[resolvedPlatform] = serverBody.body;
  }
  logger?.info?.(
    `[PromptCache] fetched server platform=${resolvedPlatform} chars=${serverBody.body.length} updatedAt=${serverBody.updatedAt}`,
  );
  return { body: serverBody.body, source: 'server' };
}

/**
 * Prefetch templates for batch publish (stored on job.promptTemplateCache).
 * @param {object} job
 * @param {object} [logger]
 */
async function ensurePromptTemplatesForBatch(job, logger) {
  job.promptTemplateCache = job.promptTemplateCache || {};
  const platforms = job.flowTarget === 'naver' ? ['naver'] : ['tistory'];
  for (const platform of platforms) {
    await ensureTemplate(
      platform,
      {
        tokenFile: job.tokenFile,
        promptTemplateCache: job.promptTemplateCache,
        cacheDir: job.promptCacheDir,
        maxAgeMs: job.promptCacheMaxAgeMs,
      },
      logger,
    );
  }
}

module.exports = {
  DEFAULT_CACHE_DIR,
  DEFAULT_MAX_AGE_MS,
  resolveTopicLine,
  assemblePrompt,
  resolveCacheDir,
  cacheFilePath,
  readDiskCache,
  writeDiskCache,
  fetchTemplateFromServer,
  isUpdatedAtStale,
  syncTemplateIfNeeded,
  ensureTemplate,
  ensurePromptTemplatesForBatch,
};
