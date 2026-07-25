'use strict';

/**
 * @file tistory_publish_harvest.js
 * @description 티스토리 발행 결과 수집 (발행 URL 획득)
 * @purpose  티스토리 발행 후 리다이렉트되는 포스트 URL을 감지하여 반환.
 *           발행 성공 여부 확인 및 최종 URL을 파이프라인에 전달.
 * @exports  harvestPublishedUrl, isTistoryPublicPostUrl, verifyPublishedUrlWithPage
 * @seeAlso  tistory_editor_inject.js, batch_publish.js
 */


const fs = require('fs');
const path = require('path');

const { sleep } = require('./common');

const FALLBACK_SELECTORS_FILE = path.join(__dirname, 'fallback_selectors.json');

const MANAGE_POSTS_INITIAL_WAIT_MS = 5000;
const MANAGE_POSTS_POLL_MS = 500;
/** Extended poll when /manage/posts list hydrates slowly (legacy autoclose timing). */
const MANAGE_POSTS_POLL_MAX_MS = 15_000;
const PUBLISH_NAV_TIMEOUT_MS = 90_000;
const PUBLISH_NAV_POLL_MS = 500;
/** Default wait before polling navigation (deferred publish layer + cover). */
const DEFAULT_PRE_PUBLISH_WAIT_MS = 10_000;

const DEFAULT_ROW_SELECTORS = [
  'ul.list_post.list_post_type2 > li',
  'ul.list_post > li',
  '.list_post > li',
  'ul.list_post > li:first-child',
];

const DEFAULT_LINK_SELECTORS = [
  '.tit_post a.link_cont',
  'a.link_cont',
  '.post_cont a.link_cont',
];

/** Public post permalink on *.tistory.com — excludes /manage/* and blog root. */
function isTistoryPublicPostUrl(url) {
  if (typeof url !== 'string' || !url.length) {
    return false;
  }
  try {
    const u = new URL(url);
    if (!/\.tistory\.com$/i.test(u.hostname)) {
      return false;
    }
    if (u.pathname.startsWith('/manage')) {
      return false;
    }
    if (u.pathname === '/' || u.pathname === '') {
      return false;
    }
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

function isTistoryManagePostsUrl(url) {
  return typeof url === 'string' && /tistory\.com\/manage\/posts/i.test(url);
}

/**
 * Legacy selArray("tistory.managePosts.postList/postLink") — fallback_selectors.json parity.
 */
function resolveManagePostsSelectors() {
  let rowSelectors = DEFAULT_ROW_SELECTORS;
  let linkSelectors = DEFAULT_LINK_SELECTORS;
  try {
    if (fs.existsSync(FALLBACK_SELECTORS_FILE)) {
      const tree = JSON.parse(fs.readFileSync(FALLBACK_SELECTORS_FILE, 'utf8'));
      const mp = tree?.tistory?.managePosts;
      if (Array.isArray(mp?.postList) && mp.postList.length) {
        rowSelectors = mp.postList;
      }
      if (Array.isArray(mp?.postLink) && mp.postLink.length) {
        linkSelectors = mp.postLink;
      }
    }
  } catch {
    /* use defaults */
  }
  return { rowSelectors, linkSelectors };
}

function buildManagePostsUrl(blogUrl) {
  let u = String(blogUrl || '').trim();
  if (!u) {
    return '';
  }
  if (!/^https?:\/\//i.test(u)) {
    u = `https://${u}`;
  }
  u = u.replace(/\/+$/, '');
  return `${u}/manage/posts`;
}

/**
 * Node-side title normalization (keep in sync with normalizeTitle inside extractLatest...Main).
 */
function normalizeHarvestPostTitle(t) {
  return String(t || '')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&nbsp;|&#160;|&#xA0;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Node-side title match (keep in sync with titlesMatch inside extractLatest...Main). */
function harvestPostTitlesMatch(expectedTitle, rowTitle) {
  const want = normalizeHarvestPostTitle(expectedTitle);
  const got = normalizeHarvestPostTitle(rowTitle);
  if (!want || !got) {
    return false;
  }
  if (want === got) {
    return true;
  }
  return got.includes(want) || want.includes(got);
}

/**
 * MAIN-world: /manage/posts ul.list_post — match row title to expected editor title (strict when title given).
 * Playwright: pass this function directly to page.evaluate (single serializable args object).
 * @param {{ rowSelectors?: string[], linkSelectors?: string[], expectedTitle?: string }} payload
 * @returns {{ url: string, title: string, matchedTitle?: boolean } | null}
 */
function extractLatestPublishedPostFromManagePageMain(payload) {
  const rowSelectors = payload?.rowSelectors;
  const linkSelectors = payload?.linkSelectors;
  const expectedTitle = payload?.expectedTitle;
  function isPublicPostHref(href) {
    if (!href || href === '#' || href.startsWith('javascript:')) {
      return false;
    }
    try {
      const parsed = new URL(href, location.origin);
      if (!/\.tistory\.com$/i.test(parsed.hostname)) {
        return false;
      }
      if (parsed.pathname.startsWith('/manage')) {
        return false;
      }
      if (parsed.pathname === '/' || parsed.pathname === '') {
        return false;
      }
      return parsed.protocol === 'https:' || parsed.protocol === 'http:';
    } catch {
      return false;
    }
  }

  function normalizeTitle(t) {
    return String(t || '')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/&nbsp;|&#160;|&#xA0;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function titlesMatch(want, got) {
    if (!want || !got) {
      return false;
    }
    if (want === got) {
      return true;
    }
    if (got.includes(want) || want.includes(got)) {
      return true;
    }
    return false;
  }

  function hitFromAnchor(a) {
    if (!a) {
      return null;
    }
    const href = a.href || a.getAttribute('href') || '';
    if (!isPublicPostHref(href)) {
      return null;
    }
    const titleAttr = (a.getAttribute('title') || '').trim();
    const textTitle = (a.textContent || '').replace(/\s+/g, ' ').trim();
    const title = titleAttr || textTitle;
    try {
      return { url: new URL(href, location.origin).href, title };
    } catch {
      if (href.startsWith('http')) {
        return { url: href, title };
      }
    }
    return null;
  }

  function findLinkInRow(row) {
    const linkSels =
      Array.isArray(linkSelectors) && linkSelectors.length
        ? linkSelectors
        : ['.tit_post a.link_cont', 'a.link_cont[href*="/entry/"]', 'a.link_cont'];
    for (const ls of linkSels) {
      const hit = hitFromAnchor(row.querySelector(ls));
      if (hit) {
        return hit;
      }
    }
    return hitFromAnchor(row.querySelector('a.link_cont'));
  }

  const wantTitle = normalizeTitle(expectedTitle);

  const listUlSelectors = ['ul.list_post.list_post_type2', 'ul.list_post'];
  let ul = null;
  for (const sel of listUlSelectors) {
    ul = document.querySelector(sel);
    if (ul) {
      break;
    }
  }

  const defaultRowSelectors = [
    'ul.list_post.list_post_type2 > li',
    'ul.list_post > li',
    '.list_post > li',
  ];
  const rowSels =
    Array.isArray(rowSelectors) && rowSelectors.length ? rowSelectors : defaultRowSelectors;
  let rows = [];
  if (ul) {
    rows = Array.from(ul.querySelectorAll(':scope > li'));
  }
  if (!rows.length) {
    for (const rs of rowSels) {
      const found = document.querySelectorAll(rs.replace(/:first-child/g, ''));
      if (found.length) {
        rows = Array.from(found);
        break;
      }
    }
  }

  if (!rows.length) {
    return null;
  }

  if (wantTitle) {
    for (const row of rows) {
      const hit = findLinkInRow(row);
      if (!hit) {
        continue;
      }
      const rowTitle = normalizeTitle(hit.title);
      if (titlesMatch(wantTitle, rowTitle)) {
        return { ...hit, matchedTitle: true };
      }
    }
    return null;
  }

  const firstHit = findLinkInRow(rows[0]);
  return firstHit ? { ...firstHit, matchedTitle: false } : null;
}

async function readTistoryEditorTitleFromPage(page) {
  return page.evaluate(() => {
    const el =
      document.querySelector('#post-title-inp') || document.querySelector('textarea.textarea_tit');
    return (el?.value || '').trim();
  });
}

async function readStashedPublishPreviewUrl(page) {
  return page.evaluate(() => {
    const v = window.__jablyTistoryLastPublishPreviewUrl;
    return typeof v === 'string' ? v.trim() : '';
  });
}

async function waitForManagePostsListReady(page, logger) {
  const deadline = Date.now() + MANAGE_POSTS_POLL_MAX_MS;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => {
      const ul =
        document.querySelector('ul.list_post.list_post_type2') ||
        document.querySelector('ul.list_post');
      if (!ul) {
        return { ready: false, count: 0 };
      }
      const links = ul.querySelectorAll(
        'li .tit_post a.link_cont[href*="/entry/"], li a.link_cont[href*="/entry/"]',
      );
      return { ready: links.length > 0, count: links.length };
    });
    if (state.ready) {
      logger?.info(
        `[Tistory] [HARVEST] ul.list_post ready (${state.count} entry link(s))`,
      );
      return true;
    }
    await sleep(MANAGE_POSTS_POLL_MS);
  }
  logger?.info('[Tistory] [HARVEST] ul.list_post not ready after poll');
  return false;
}

async function tryResolveStashedPublishPreview(page, expectedTitle, logger) {
  const url = await readStashedPublishPreviewUrl(page);
  if (!url || !isTistoryPublicPostUrl(url)) {
    return null;
  }
  const want = String(expectedTitle || '').trim();
  if (want) {
    const slug = url.split('/entry/')[1]?.split('?')[0] || '';
    const slugNorm = decodeURIComponent(slug).replace(/-/g, ' ').toLowerCase();
    const wantNorm = want.toLowerCase();
    if (slugNorm && wantNorm && !slugNorm.includes(wantNorm) && !wantNorm.includes(slugNorm)) {
      return null;
    }
  }
  logger?.info(
    `[Tistory] [HARVEST] publish_preview_url ${JSON.stringify({ url: url.slice(0, 120) })}`,
  );
  return {
    ok: true,
    url,
    title: want || url,
    source: 'publish_preview_url',
    matchedTitle: true,
  };
}

function isHarvestDebugEnabled() {
  return process.env.JA_HARVEST_DEBUG === '1' || process.env.JA_DEBUG === '1';
}

/**
 * Editor title wins unless forcePostTitle is set (debug fixture 123123 parity).
 */
async function resolveHarvestExpectedTitle(page, options = {}) {
  const forced = String(options.forcePostTitle || '').trim();
  if (forced) {
    return forced;
  }
  const preset = String(options.expectedTitle || '').trim();
  if (preset) {
    return preset;
  }
  try {
    const editorTitle = await readTistoryEditorTitleFromPage(page);
    if (editorTitle) {
      return editorTitle;
    }
  } catch {
    /* ignore */
  }
  return '';
}

async function gotoManagePostsAndResolve(page, blogUrl, expectedTitle, logger, harvestOpts = {}) {
  const manageUrl = buildManagePostsUrl(blogUrl);
  if (!manageUrl) {
    return null;
  }
  logger?.info(`[Tistory] [HARVEST] open manage/posts: ${manageUrl}`);
  try {
    await page.goto(manageUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    return resolveFromManagePostsList(page, expectedTitle, logger, harvestOpts);
  } catch (error) {
    logger?.info(
      `[Tistory] [HARVEST] manage/posts goto failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

async function extractLatestPublishedPostFromManagePage(page, rowSelectors, linkSelectors, expectedTitle) {
  const resolved = resolveManagePostsSelectors();
  // Pass function reference — Playwright serializes its body; closure refs are not available in browser.
  return page.evaluate(extractLatestPublishedPostFromManagePageMain, {
    rowSelectors: rowSelectors || resolved.rowSelectors,
    linkSelectors: linkSelectors || resolved.linkSelectors,
    expectedTitle: String(expectedTitle || '').trim(),
  });
}

/**
 * Resolve post URL from /manage/posts list — 5s hydrate, then title-matched row (legacy parity).
 */
async function resolveFromManagePostsList(page, expectedTitle, logger, harvestOpts = {}) {
  const titleFallback = String(expectedTitle || '').trim();
  const debugFixtureHarvest = harvestOpts.debugFixtureHarvest === true;

  logger?.info(
    `Waiting ${MANAGE_POSTS_INITIAL_WAIT_MS}ms for ul.list_post on /manage/posts...`,
  );
  if (isHarvestDebugEnabled()) {
    logger?.info(
      `[Tistory] [HARVEST] expectedTitle=${JSON.stringify(titleFallback.slice(0, 80))} debugFixture=${debugFixtureHarvest}`,
    );
  }
  await sleep(MANAGE_POSTS_INITIAL_WAIT_MS);
  await waitForManagePostsListReady(page, logger);

  const pollDeadline = Date.now() + MANAGE_POSTS_POLL_MAX_MS;
  while (Date.now() < pollDeadline) {
    const extracted = await extractLatestPublishedPostFromManagePage(
      page,
      null,
      null,
      titleFallback,
    );
    if (isHarvestDebugEnabled() && extracted) {
      logger?.info(
        `[Tistory] [HARVEST] poll ${JSON.stringify({
          url: (extracted.url || '').slice(0, 80),
          title: (extracted.title || '').slice(0, 60),
          matchedTitle: extracted.matchedTitle === true,
        })}`,
      );
    }
    if (extracted?.url && isTistoryPublicPostUrl(extracted.url) && extracted.matchedTitle === true) {
      logger?.info(
        `[Tistory] [HARVEST] manage_posts_list ${JSON.stringify({
          url: extracted.url.slice(0, 120),
          title: (extracted.title || '').slice(0, 80),
          matchedTitle: true,
        })}`,
      );
      return {
        ok: true,
        url: extracted.url,
        title: extracted.title || titleFallback,
        source: 'manage_posts_list',
        matchedTitle: true,
      };
    }
    await sleep(MANAGE_POSTS_POLL_MS);
  }

  if (titleFallback && debugFixtureHarvest) {
    const legacyRow = await extractLatestPublishedPostFromManagePage(page, null, null, '');
    if (legacyRow?.url && isTistoryPublicPostUrl(legacyRow.url)) {
      if (harvestPostTitlesMatch(titleFallback, legacyRow.title)) {
        logger?.info(
          `[Tistory] [HARVEST] debug_fixture first-row ${JSON.stringify({
            url: legacyRow.url.slice(0, 120),
            title: (legacyRow.title || '').slice(0, 80),
            matchedTitle: true,
          })}`,
        );
        return {
          ok: true,
          url: legacyRow.url,
          title: legacyRow.title || titleFallback,
          source: 'manage_posts_list_first_row',
          matchedTitle: true,
        };
      }
      if (isHarvestDebugEnabled()) {
        logger?.info(
          `[Tistory] [HARVEST] debug_fixture first-row title mismatch ${JSON.stringify({
            expectedTitle: titleFallback.slice(0, 80),
            rowTitle: (legacyRow.title || '').slice(0, 80),
          })}`,
        );
      }
    }
  }

  if (titleFallback) {
    const preview = await tryResolveStashedPublishPreview(page, titleFallback, logger);
    if (preview) {
      return preview;
    }
    logger?.info(
      `[Tistory] [HARVEST] title not found in list ${JSON.stringify({
        expectedTitle: titleFallback.slice(0, 80),
        pageUrl: String(page.url() || '').slice(0, 120),
      })}`,
    );
  }

  return {
    ok: false,
    url: '',
    title: titleFallback,
    source: 'unresolved',
    reason: 'post_url_unresolved',
  };
}

/**
 * bg-tistory-kakao-flow.js resolvePublishedPostFromTab (Playwright page variant).
 */
async function resolvePublishedPostFromPage(page, navigationUrl, expectedTitle, logger, harvestOpts = {}) {
  const titleFallback = String(expectedTitle || '').trim();

  if (isTistoryPublicPostUrl(navigationUrl)) {
    return {
      ok: true,
      url: navigationUrl,
      title: titleFallback,
      source: 'navigation_permalink',
      matchedTitle: true,
    };
  }

  if (isTistoryManagePostsUrl(navigationUrl) || navigationUrl.includes('tistory.com')) {
    return resolveFromManagePostsList(page, titleFallback, logger, harvestOpts);
  }

  return {
    ok: false,
    url: navigationUrl,
    title: titleFallback,
    source: 'unresolved',
    reason: 'published_url_unresolved',
  };
}

/**
 * Wait until Tistory leaves /manage/newpost after #publish-btn (maybeAutocloseTistoryPublishTab trigger).
 */
async function waitForPublishNavigation(page, logger, timeoutMs = PUBLISH_NAV_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  logger?.info(`Waiting for publish navigation (timeout ${timeoutMs}ms)...`);

  while (Date.now() < deadline) {
    const url = page.url();
    if (url.includes('tistory.com') && !url.includes('/manage/newpost')) {
      logger?.info(`Publish navigation detected: ${url.slice(0, 140)}`);
      return { ok: true, url };
    }
    await sleep(PUBLISH_NAV_POLL_MS);
  }

  const finalUrl = page.url();
  logger?.info(`Publish navigation timeout; still at ${finalUrl.slice(0, 140)}`);
  return { ok: false, url: finalUrl, reason: 'publish_nav_timeout' };
}

/**
 * Harvest published post URL + title after auto-publish.
 * @param {import('playwright').Page} page
 * @param {{ logger?: object, expectedTitle?: string, blogUrl?: string, timeoutMs?: number }} [options]
 */
async function harvestPublishedPost(page, options = {}) {
  const logger = options.logger;
  const blogUrl = String(options.blogUrl || '').trim();
  const expectedTitle = await resolveHarvestExpectedTitle(page, options);
  const harvestOpts = {
    debugFixtureHarvest: options.debugFixtureHarvest === true,
  };

  if (isHarvestDebugEnabled()) {
    logger?.info(
      `[Tistory] [HARVEST] begin ${JSON.stringify({
        expectedTitle: expectedTitle.slice(0, 80),
        blogUrl: blogUrl.slice(0, 80),
        debugFixture: harvestOpts.debugFixtureHarvest,
      })}`,
    );
  }

  const preWaitMs =
    typeof options.prePublishWaitMs === 'number' && options.prePublishWaitMs >= 0
      ? options.prePublishWaitMs
      : DEFAULT_PRE_PUBLISH_WAIT_MS;
  if (preWaitMs > 0) {
    logger?.info(
      `Waiting ${preWaitMs}ms for publish layer (#publish-btn) before harvest...`,
    );
    await sleep(preWaitMs);
  }

  const nav = await waitForPublishNavigation(page, logger, options.timeoutMs);
  if (!nav.ok) {
    if (blogUrl) {
      const fallback = await gotoManagePostsAndResolve(
        page,
        blogUrl,
        expectedTitle,
        logger,
        harvestOpts,
      );
      if (fallback?.ok) {
        return fallback;
      }
    }
    return {
      ok: false,
      url: nav.url || '',
      title: expectedTitle,
      source: 'unresolved',
      reason: nav.reason || 'publish_nav_timeout',
    };
  }

  let resolved = await resolvePublishedPostFromPage(
    page,
    nav.url,
    expectedTitle,
    logger,
    harvestOpts,
  );

  if (!resolved.ok && blogUrl) {
    logger?.info('[Tistory] [HARVEST] re-open manage/posts for title match...');
    const refreshed = await gotoManagePostsAndResolve(
      page,
      blogUrl,
      expectedTitle,
      logger,
      harvestOpts,
    );
    if (refreshed?.ok) {
      resolved = refreshed;
    }
  }

  return resolved;
}

function logPublishedJsonLine(logger, payload) {
  const body = {
    url: payload?.url || '',
    title: payload?.title || '',
  };
  logger?.info(`[Tistory] [PUBLISHED] ${JSON.stringify(body)}`);
  return body;
}

function extractFirstH1PlainTextFromHtml(html) {
  if (!html || typeof html !== 'string') {
    return '';
  }
  try {
    const match = html.match(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i);
    let rawText = '';
    if (!match) {
      const pMatch = html.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
      if (pMatch) {
        rawText = pMatch[1];
        let cleaned = rawText.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;|&#xA0;/gi, ' ').replace(/\s+/g, ' ').trim();
        if (cleaned.length > 50) cleaned = cleaned.substring(0, 50) + '...';
        return cleaned;
      }
      return '';
    } else {
      rawText = match[1];
    }
    return rawText
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;|&#160;|&#xA0;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    return '';
  }
}

module.exports = {
  MANAGE_POSTS_INITIAL_WAIT_MS,
  MANAGE_POSTS_POLL_MS,
  MANAGE_POSTS_POLL_MAX_MS,
  PUBLISH_NAV_TIMEOUT_MS,
  DEFAULT_PRE_PUBLISH_WAIT_MS,
  DEFAULT_ROW_SELECTORS,
  DEFAULT_LINK_SELECTORS,
  isTistoryPublicPostUrl,
  isTistoryManagePostsUrl,
  buildManagePostsUrl,
  resolveManagePostsSelectors,
  normalizeHarvestPostTitle,
  harvestPostTitlesMatch,
  extractLatestPublishedPostFromManagePageMain,
  extractLatestPublishedPostFromManagePage,
  readTistoryEditorTitleFromPage,
  resolveHarvestExpectedTitle,
  resolvePublishedPostFromPage,
  waitForPublishNavigation,
  harvestPublishedPost,
  logPublishedJsonLine,
  extractFirstH1PlainTextFromHtml,
};
