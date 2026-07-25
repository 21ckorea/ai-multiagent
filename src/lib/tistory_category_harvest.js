'use strict';

/**
 * @file tistory_category_harvest.js
 * @description 티스토리 카테고리 목록 자동 수집
 * @purpose  티스토리 관리 페이지에 접속하여 사용 가능한 카테고리 목록을 긁어와
 *           배치 발행 시 자동 카테고리 선택에 활용.
 * @exports  harvestTistoryCategories
 * @seeAlso  tistory_editor_inject.js, playwright_tistory_login.js
 */


const FALLBACK_SELECTORS = require('./fallback_selectors.json');

const CATEGORY_HARVEST_POLL_MS = 150;
const CATEGORY_HARVEST_MAX_POLLS = 80;

/** Last-resort defaults when fallback_selectors.json is missing entries. */
const HARDCODED_CATEGORY_DEFAULTS = {
  btn: ['#category-btn'],
  list: ['#category-list'],
  items: ['[id^="category-item-"]'],
  label: ['.mce-text'],
};

/**
 * Normalize a selector config value to a non-empty string array.
 * @param {string|string[]|undefined} value
 * @param {string[]} fallback
 * @returns {string[]}
 */
function toSelectorArray(value, fallback) {
  if (Array.isArray(value)) {
    const cleaned = value.map((s) => String(s).trim()).filter(Boolean);
    if (cleaned.length > 0) {
      return cleaned;
    }
  } else if (typeof value === 'string' && value.trim()) {
    return [value.trim()];
  }
  return [...fallback];
}

/**
 * Merge JSON selectors with hardcoded defaults (JSON first, deduped).
 * @param {object} [overrides]
 * @returns {{ btn: string[], list: string[], items: string[], label: string[] }}
 */
function resolveCategorySelectors(overrides) {
  const fromJson = FALLBACK_SELECTORS.tistory?.category || {};
  const dedupe = (arr) => [...new Set(arr)];

  const resolved = {
    btn: dedupe([
      ...toSelectorArray(fromJson.btn, []),
      ...HARDCODED_CATEGORY_DEFAULTS.btn,
    ]),
    list: dedupe([
      ...toSelectorArray(fromJson.list, []),
      ...HARDCODED_CATEGORY_DEFAULTS.list,
    ]),
    items: dedupe([
      ...toSelectorArray(fromJson.items, []),
      ...HARDCODED_CATEGORY_DEFAULTS.items,
    ]),
    label: dedupe([
      ...toSelectorArray(fromJson.label, []),
      ...HARDCODED_CATEGORY_DEFAULTS.label,
    ]),
  };

  if (overrides && typeof overrides === 'object') {
    for (const key of ['btn', 'list', 'items', 'label']) {
      if (overrides[key] !== undefined) {
        resolved[key] = dedupe([
          ...toSelectorArray(overrides[key], []),
          ...HARDCODED_CATEGORY_DEFAULTS[key],
        ]);
      }
    }
  }

  return resolved;
}

const CATEGORY_SELECTORS = resolveCategorySelectors();

/**
 * Injected in page context — harvest category list from /manage/newpost.
 * @param {{ selectors?: object, pollMs?: number, maxPolls?: number } | object} config
 * @returns {Promise<{ ok: boolean, items?: Array, error?: string, failedStage?: string }>}
 */
async function harvestCategoriesInPage(config) {
  const pollMs = typeof config?.pollMs === 'number' ? config.pollMs : 150;
  const maxPolls = typeof config?.maxPolls === 'number' ? config.maxPolls : 80;
  const sels = config?.selectors ?? config ?? {};
  const defaults = {
    btn: ['#category-btn'],
    list: ['#category-list'],
    items: ['[id^="category-item-"]'],
    label: ['.mce-text'],
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const btnSelectors = sels.btn || defaults.btn;
  const listSelectors = sels.list || defaults.list;
  const itemSelectors = sels.items || defaults.items;
  const labelSelectors = sels.label || defaults.label;

  function qFirst(root, arr) {
    for (const s of arr) {
      const el = root.querySelector(s);
      if (el) {
        return el;
      }
    }
    return null;
  }

  function qAll(root, arr) {
    for (const s of arr) {
      const els = root.querySelectorAll(s);
      if (els.length > 0) {
        return els;
      }
    }
    return [];
  }

  const btn = qFirst(document, btnSelectors);
  if (!btn) {
    return { ok: false, error: 'no_category_btn', failedStage: 'btn' };
  }

  try {
    btn.click();
  } catch {
    return { ok: false, error: 'category_btn_click', failedStage: 'btn_click' };
  }

  let listSeen = false;
  for (let i = 0; i < maxPolls; i += 1) {
    await sleep(pollMs);
    const list = qFirst(document, listSelectors);
    if (list) {
      listSeen = true;
    }
    const nodes = list ? qAll(list, itemSelectors) : [];
    if (list && nodes.length > 0) {
      const items = [];
      nodes.forEach((el) => {
        const elementId = el.id || '';
        const categoryId = el.getAttribute('category-id') || '';
        const txt = qFirst(el, labelSelectors);
        const label = (txt?.textContent || '').replace(/\s+/g, ' ').trim();
        if (elementId) {
          items.push({ elementId, categoryId, label });
        }
      });
      return items.length
        ? { ok: true, items }
        : { ok: false, error: 'empty_category_list', failedStage: 'empty_items' };
    }
  }

  return {
    ok: false,
    error: 'category_list_timeout',
    failedStage: listSeen ? 'items' : 'list',
  };
}

/**
 * Log harvest failure diagnostics (no secrets).
 * @param {object} logger
 * @param {object} harvest
 * @param {string|(() => string)} urlOrGetter
 * @param {object} [selectors]
 */
function logHarvestDiagnostics(logger, harvest, urlOrGetter, selectors) {
  if (!logger || harvest?.ok) {
    return;
  }

  const url = typeof urlOrGetter === 'function' ? urlOrGetter() : urlOrGetter;
  const stage = harvest?.failedStage || harvest?.error || 'unknown';
  const sels = selectors || CATEGORY_SELECTORS;

  logger.info(`[Tistory] Category harvest failed at stage=${stage} error=${harvest?.error || 'unknown'}`);
  if (url) {
    logger.info(`[Tistory] Category harvest URL: ${url}`);
  }
  logger.info(
    `[Tistory] Category harvest selectors tried: btn=${JSON.stringify(sels.btn)} list=${JSON.stringify(sels.list)} items=${JSON.stringify(sels.items)} label=${JSON.stringify(sels.label)}`,
  );
  logger.info('[Tistory] [CATEGORIES] omitted (harvest failed)');
}

async function harvestCategories(page, logger) {
  const selectors = resolveCategorySelectors();
  const config = {
    selectors,
    pollMs: CATEGORY_HARVEST_POLL_MS,
    maxPolls: CATEGORY_HARVEST_MAX_POLLS,
  };

  try {
    const harvest = await page.evaluate(harvestCategoriesInPage, config);
    if (logger) {
      logHarvestDiagnostics(logger, harvest, () => page.url(), selectors);
    }
    return harvest;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const harvest = {
      ok: false,
      error: 'category_evaluate_error',
      failedStage: 'evaluate',
      detail: message.slice(0, 220),
    };
    if (logger) {
      logger.info(`[Tistory] Category harvest evaluate error: ${message.slice(0, 200)}`);
      logHarvestDiagnostics(logger, harvest, () => page.url(), selectors);
    }
    return harvest;
  }
}

async function harvestCategoriesDriver(driver, logger) {
  const selectors = resolveCategorySelectors();
  const config = {
    selectors,
    pollMs: CATEGORY_HARVEST_POLL_MS,
    maxPolls: CATEGORY_HARVEST_MAX_POLLS,
  };
  const script = `
    const fn = ${harvestCategoriesInPage.toString()};
    fn(arguments[0]).then((result) => arguments[arguments.length - 1](result));
  `;
  try {
    const harvest = await driver.executeAsyncScript(script, config);
    if (logger) {
      let url = '';
      try {
        url = await driver.getCurrentUrl();
      } catch {
        // ignore
      }
      logHarvestDiagnostics(logger, harvest, url, selectors);
    }
    return harvest;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const harvest = {
      ok: false,
      error: 'category_evaluate_error',
      failedStage: 'evaluate',
      detail: message.slice(0, 220),
    };
    if (logger) {
      logger.info(`[Tistory] Category harvest evaluate error: ${message.slice(0, 200)}`);
      logHarvestDiagnostics(logger, harvest, '', selectors);
    }
    return harvest;
  }
}

/** @param {'playwright'|'selenium'} engine */
async function harvestCategoriesForEngine(engine, session, logger) {
  if (engine === 'selenium') {
    return harvestCategoriesDriver(session, logger);
  }
  return harvestCategories(session, logger);
}

/** Flutter parsing: [Playwright|Selenium] [Tistory] [CATEGORIES] {"items":[...]} */
function logCategoriesJsonLines(logger, harvest) {
  if (harvest?.ok && Array.isArray(harvest.items) && harvest.items.length > 0) {
    logger.info(`[Tistory] [CATEGORIES] ${JSON.stringify({ items: harvest.items })}`);
    return;
  }
  if (harvest?.ok) {
    logger.info('[Tistory] [CATEGORIES] omitted (empty items after harvest)');
    return;
  }
  logger.info('[Tistory] [CATEGORIES] omitted (harvest failed)');
}

module.exports = {
  CATEGORY_HARVEST_POLL_MS,
  CATEGORY_HARVEST_MAX_POLLS,
  HARDCODED_CATEGORY_DEFAULTS,
  CATEGORY_SELECTORS,
  toSelectorArray,
  resolveCategorySelectors,
  harvestCategoriesInPage,
  logHarvestDiagnostics,
  harvestCategories,
  harvestCategoriesDriver,
  harvestCategoriesForEngine,
  logCategoriesJsonLines,
};
