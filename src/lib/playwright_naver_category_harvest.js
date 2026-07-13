'use strict';

/**
 * @file playwright_naver_category_harvest.js
 * @description 네이버 블로그 카테고리 목록 자동 수집 (Playwright)
 * @purpose  네이버 블로그 관리 페이지에 접속하여 카테고리 목록을 긁어와
 *           배치 발행 시 카테고리 자동 매핑에 활용.
 * @exports  harvestNaverCategories
 * @seeAlso  playwright_naver_pipeline.js
 */


// Naver SmartEditor category harvest.
//
// Flow (from the blog write page `https://blog.naver.com/{id}?Redirect=Write&`):
//   1. Click the 발행 button   -> opens the publish settings panel
//   2. Click the 카테고리 목록 버튼 (selectbox) -> opens the category <ul>
//   3. Read each <li>: input#<elementId> + <span data-testid="categoryItemText_N">
//
// Emits, for Flutter to parse:  [NAVER] [CATEGORIES] {"items":[...]}

const NAVER_CATEGORY_POLL_MS = 200;
const NAVER_CATEGORY_MAX_POLLS = 50;

/**
 * Injected in page context — harvest the Naver category list.
 * @param {{ pollMs?: number, maxPolls?: number }} config
 * @returns {Promise<{ ok: boolean, items?: Array, error?: string, failedStage?: string }>}
 */
async function harvestNaverCategoriesInPage(config) {
  const pollMs = typeof config?.pollMs === 'number' ? config.pollMs : 200;
  const maxPolls = typeof config?.maxPolls === 'number' ? config.maxPolls : 50;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const publishBtnSelectors = [
    'button[data-click-area="tpb.publish"]',
    'button.publish_btn__m9KHH',
  ];
  const categoryBtnSelectors = [
    'button[aria-label="카테고리 목록 버튼"]',
    'button.selectbox_button__jb1Dt',
  ];
  const listSelectors = ['ul.list__RcvVA'];
  const itemSelectors = ['li.item__sAGX9'];

  // Diagnostics returned to the Node logger.
  const dbg = {
    popupContainers: 0,
    popupTitle: '',
    cancelFound: false,
    cancelClicked: false,
    publishFound: false,
    categoryBtnFound: false,
    listFound: false,
    itemCount: 0,
  };

  function qFirst(root, arr) {
    for (const s of arr) {
      const el = root.querySelector(s);
      if (el) {
        return el;
      }
    }
    return null;
  }

  // Dismiss the "작성 중인 글이 있습니다" draft-restore popup (click 취소).
  function dismissDraftPopup() {
    const popups = document.querySelectorAll('.se-popup-container');
    dbg.popupContainers = popups.length;
    for (const popup of popups) {
      const title = (popup.querySelector('.se-popup-title')?.textContent || '')
        .replace(/\s+/g, ' ')
        .trim();
      if (title) {
        dbg.popupTitle = title;
      }
      const cancelBtn =
        popup.querySelector('button.se-popup-button-cancel') ||
        popup.querySelector('.se-popup-button-cancel');
      if (cancelBtn) {
        dbg.cancelFound = true;
        // The draft-restore popup is the one we cancel.
        if (/작성\s*중인\s*글/.test(title) || title === '') {
          cancelBtn.click();
          dbg.cancelClicked = true;
          return true;
        }
      }
    }
    return false;
  }

  // FIRST: look for the draft popup and click 취소 if present (skip if not).
  for (let i = 0; i < 12; i += 1) {
    if (dismissDraftPopup()) {
      await sleep(300);
      break;
    }
    await sleep(200);
  }

  // 1. Open the publish settings panel (guard against a late popup first).
  dismissDraftPopup();
  const publishBtn = qFirst(document, publishBtnSelectors);
  dbg.publishFound = !!publishBtn;
  if (!publishBtn) {
    return { ok: false, error: 'no_publish_btn', failedStage: 'publish_btn', debug: dbg };
  }
  try {
    publishBtn.click();
  } catch {
    return { ok: false, error: 'publish_btn_click', failedStage: 'publish_btn_click', debug: dbg };
  }

  // 2. Wait for and click the category selectbox button. Keep dismissing the
  // draft popup, and re-click 발행 in case the first click was swallowed by it.
  let categoryBtn = null;
  for (let i = 0; i < maxPolls; i += 1) {
    await sleep(pollMs);
    dismissDraftPopup();
    categoryBtn = qFirst(document, categoryBtnSelectors);
    if (categoryBtn) {
      break;
    }
    if (i === 5 || i === 12) {
      const pb = qFirst(document, publishBtnSelectors);
      if (pb) {
        try {
          pb.click();
        } catch {
          /* ignore */
        }
      }
    }
  }
  dbg.categoryBtnFound = !!categoryBtn;
  if (!categoryBtn) {
    return { ok: false, error: 'no_category_btn', failedStage: 'category_btn', debug: dbg };
  }
  try {
    categoryBtn.click();
  } catch {
    return { ok: false, error: 'category_btn_click', failedStage: 'category_btn_click', debug: dbg };
  }

  // 3. Poll for the category <ul> and read its <li> items.
  let listSeen = false;
  for (let i = 0; i < maxPolls; i += 1) {
    await sleep(pollMs);
    const list = qFirst(document, listSelectors);
    if (list) {
      listSeen = true;
      dbg.listFound = true;
    }
    const nodes = list ? list.querySelectorAll(itemSelectors[0]) : [];
    dbg.itemCount = nodes.length;
    if (list && nodes.length > 0) {
      const items = [];
      nodes.forEach((li) => {
        const input = li.querySelector('input[type="radio"]');
        const elementId = input?.id || '';
        let categoryId = '';
        if (elementId.includes('_')) {
          categoryId = elementId.split('_')[0];
        }
        if (!categoryId) {
          const testid = input?.getAttribute('data-testid') || '';
          const m = testid.match(/categoryBtn_(\w+)/);
          if (m) {
            categoryId = m[1];
          }
        }
        const labelEl =
          li.querySelector('label .text__sraQE') ||
          li.querySelector('label span') ||
          li.querySelector('label');
        const label = (labelEl?.textContent || '').replace(/\s+/g, ' ').trim();
        if (elementId) {
          items.push({ elementId, categoryId, label });
        }
      });
      return items.length
        ? { ok: true, items, debug: dbg }
        : { ok: false, error: 'empty_category_list', failedStage: 'empty_items', debug: dbg };
    }
  }

  return {
    ok: false,
    error: 'category_list_timeout',
    failedStage: listSeen ? 'items' : 'list',
    debug: dbg,
  };
}

/** Cheap probe (no clicks/waits) to find which frame hosts the editor. */
function probeNaverFrame() {
  return {
    hasPublish: !!(
      document.querySelector('button[data-click-area="tpb.publish"]') ||
      document.querySelector('button.publish_btn__m9KHH')
    ),
    hasPopup: !!document.querySelector('.se-popup-container'),
    hasCategoryBtn: !!document.querySelector('button[aria-label="카테고리 목록 버튼"]'),
  };
}

async function harvestNaverCategories(page, logger) {
  const config = {
    pollMs: NAVER_CATEGORY_POLL_MS,
    maxPolls: NAVER_CATEGORY_MAX_POLLS,
  };

  // The SmartEditor (publish panel + draft popup + categories) lives inside an
  // iframe, so the main document sees nothing. Scan every frame to find it.
  let chosen = null;
  for (let attempt = 0; attempt < 5 && !chosen; attempt += 1) {
    const frames = page.frames();
    logger?.info?.(
      `[NAVER] harvest scan attempt ${attempt + 1}: ${frames.length} frame(s)`,
    );
    let popupFrame = null;
    for (const f of frames) {
      let probe = null;
      try {
        probe = await f.evaluate(probeNaverFrame);
      } catch (e) {
        logger?.info?.(
          `[NAVER] frame probe error (${(f.url() || '').slice(0, 60)}): ${String(e).slice(0, 100)}`,
        );
        continue;
      }
      logger?.info?.(
        `[NAVER] frame ${(f.url() || 'about:blank').slice(0, 70)} -> ${JSON.stringify(probe)}`,
      );
      if ((probe.hasPublish || probe.hasCategoryBtn) && !chosen) {
        chosen = f;
      }
      if (probe.hasPopup && !popupFrame) {
        popupFrame = f;
      }
    }
    if (!chosen && popupFrame) {
      chosen = popupFrame;
    }
    if (!chosen) {
      await page.waitForTimeout(900);
    }
  }

  const targetFrame = chosen || page.mainFrame();
  logger?.info?.(
    `[NAVER] harvest target frame: ${(targetFrame.url() || 'main').slice(0, 70)}`,
  );

  try {
    const harvest = await targetFrame.evaluate(harvestNaverCategoriesInPage, config);
    logger?.info?.(
      `[NAVER] harvest result: ${JSON.stringify({
        ok: harvest?.ok,
        error: harvest?.error,
        stage: harvest?.failedStage,
        count: harvest?.items?.length || 0,
        debug: harvest?.debug,
      })}`,
    );
    return harvest;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger?.info?.(`[NAVER] Category harvest evaluate error: ${message.slice(0, 200)}`);
    return { ok: false, error: 'category_evaluate_error', failedStage: 'evaluate' };
  }
}

/** Emits the marker Flutter parses: [NAVER] [CATEGORIES] {"items":[...]} */
function logNaverCategoriesJsonLines(logger, harvest) {
  if (harvest?.ok && Array.isArray(harvest.items) && harvest.items.length > 0) {
    logger.info(`[NAVER] [CATEGORIES] ${JSON.stringify({ items: harvest.items })}`);
    return;
  }
  if (harvest?.ok) {
    logger.info('[NAVER] [CATEGORIES] omitted (empty items after harvest)');
    return;
  }
  logger.info('[NAVER] [CATEGORIES] omitted (harvest failed)');
}

// ---------------------------------------------------------------------------
// 블로그 주제 (subject/theme) harvest — same publish panel, the 주제 dropdown.
//   1. (panel already opened by the category harvest, or click 발행)
//   2. Click the 주제 목록 버튼 (a[data-click-area="tpb*i.subject"])
//   3. Read every <li> across theme groups (div.theme_list__kENpz):
//      input#<elementId> (e.g. "영화_6") + <label> text, plus the group title.
// Emits:  [NAVER] [SUBJECTS] {"items":[...]}
// ---------------------------------------------------------------------------

async function harvestNaverSubjectsInPage(config) {
  const pollMs = typeof config?.pollMs === 'number' ? config.pollMs : 200;
  const maxPolls = typeof config?.maxPolls === 'number' ? config.maxPolls : 50;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const publishBtnSelectors = [
    'button[data-click-area="tpb.publish"]',
    'button.publish_btn__m9KHH',
  ];
  const subjectBtnSelectors = [
    'a[data-click-area="tpb*i.subject"]',
    'a[aria-label="주제 목록 버튼"]',
    'a.link__g9ed3',
  ];
  const dbg = { subjectBtnFound: false, gridFound: false, groupCount: 0, itemCount: 0 };

  function qFirst(root, arr) {
    for (const s of arr) {
      const el = root.querySelector(s);
      if (el) return el;
    }
    return null;
  }

  function dismissDraftPopup() {
    const popups = document.querySelectorAll('.se-popup-container');
    for (const popup of popups) {
      const title = (popup.querySelector('.se-popup-title')?.textContent || '')
        .replace(/\s+/g, ' ')
        .trim();
      const cancelBtn =
        popup.querySelector('button.se-popup-button-cancel') ||
        popup.querySelector('.se-popup-button-cancel');
      if (cancelBtn && (/작성\s*중인\s*글/.test(title) || title === '')) {
        cancelBtn.click();
        return true;
      }
    }
    return false;
  }

  // Ensure the publish panel is open, then click the 주제 button.
  let subjectBtn = qFirst(document, subjectBtnSelectors);
  if (!subjectBtn) {
    const pb = qFirst(document, publishBtnSelectors);
    if (pb) {
      try {
        pb.click();
      } catch {
        /* ignore */
      }
    }
    for (let i = 0; i < maxPolls && !subjectBtn; i += 1) {
      await sleep(pollMs);
      dismissDraftPopup();
      subjectBtn = qFirst(document, subjectBtnSelectors);
    }
  }
  dbg.subjectBtnFound = !!subjectBtn;
  if (!subjectBtn) {
    return { ok: false, error: 'no_subject_btn', failedStage: 'subject_btn', debug: dbg };
  }
  try {
    subjectBtn.click();
  } catch {
    return { ok: false, error: 'subject_btn_click', failedStage: 'subject_btn_click', debug: dbg };
  }

  // Poll for the theme grid, read items across all groups.
  for (let i = 0; i < maxPolls; i += 1) {
    await sleep(pollMs);
    const wrap =
      document.querySelector('div.theme_list_wrap__IpKh9') ||
      document.querySelector('.theme_list_wrap__IpKh9');
    if (wrap) dbg.gridFound = true;
    const groups = wrap ? wrap.querySelectorAll('div.theme_list__kENpz') : [];
    dbg.groupCount = groups.length;
    if (wrap && groups.length) {
      const items = [];
      groups.forEach((g) => {
        const groupTitle = (g.querySelector('strong.title__TtSbZ')?.textContent || '')
          .replace(/\s+/g, ' ')
          .trim();
        g.querySelectorAll('li.item__sAGX9').forEach((li) => {
          const input =
            li.querySelector('input[data-click-area="tpb*i.subjectlist"]') ||
            li.querySelector('input[type="radio"]');
          const elementId = input?.id || '';
          if (!elementId || elementId === 'non-theme') return;
          let subjectId = '';
          if (elementId.includes('_')) {
            subjectId = elementId.slice(elementId.lastIndexOf('_') + 1);
          }
          const labelEl = li.querySelector('label') || li.querySelector('label span');
          const label = (labelEl?.textContent || '').replace(/\s+/g, ' ').trim();
          if (elementId) {
            items.push({ elementId, subjectId, label, group: groupTitle });
          }
        });
      });
      dbg.itemCount = items.length;
      if (items.length) {
        return { ok: true, items, debug: dbg };
      }
    }
  }

  return {
    ok: false,
    error: 'subject_grid_timeout',
    failedStage: dbg.gridFound ? 'items' : 'grid',
    debug: dbg,
  };
}

function probeNaverSubjectFrame() {
  return {
    hasPublish: !!(
      document.querySelector('button[data-click-area="tpb.publish"]') ||
      document.querySelector('button.publish_btn__m9KHH')
    ),
    hasSubjectBtn: !!(
      document.querySelector('a[data-click-area="tpb*i.subject"]') ||
      document.querySelector('a[aria-label="주제 목록 버튼"]')
    ),
  };
}

async function harvestNaverSubjects(page, logger) {
  const config = { pollMs: NAVER_CATEGORY_POLL_MS, maxPolls: NAVER_CATEGORY_MAX_POLLS };
  let chosen = null;
  for (let attempt = 0; attempt < 5 && !chosen; attempt += 1) {
    for (const f of page.frames()) {
      let probe = null;
      try {
        probe = await f.evaluate(probeNaverSubjectFrame);
      } catch {
        continue;
      }
      if ((probe.hasPublish || probe.hasSubjectBtn) && !chosen) {
        chosen = f;
        break;
      }
    }
    if (!chosen) await page.waitForTimeout(800);
  }
  const targetFrame = chosen || page.mainFrame();
  logger?.info?.(
    `[NAVER] subject harvest target frame: ${(targetFrame.url() || 'main').slice(0, 70)}`,
  );
  try {
    const harvest = await targetFrame.evaluate(harvestNaverSubjectsInPage, config);
    logger?.info?.(
      `[NAVER] subject harvest result: ${JSON.stringify({
        ok: harvest?.ok,
        error: harvest?.error,
        stage: harvest?.failedStage,
        count: harvest?.items?.length || 0,
        debug: harvest?.debug,
      })}`,
    );
    return harvest;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger?.info?.(`[NAVER] Subject harvest evaluate error: ${message.slice(0, 200)}`);
    return { ok: false, error: 'subject_evaluate_error', failedStage: 'evaluate' };
  }
}

/** Emits the marker Flutter parses: [NAVER] [SUBJECTS] {"items":[...]} */
function logNaverSubjectsJsonLines(logger, harvest) {
  if (harvest?.ok && Array.isArray(harvest.items) && harvest.items.length > 0) {
    logger.info(`[NAVER] [SUBJECTS] ${JSON.stringify({ items: harvest.items })}`);
    return;
  }
  logger.info('[NAVER] [SUBJECTS] omitted (subject harvest failed)');
}

module.exports = {
  NAVER_CATEGORY_POLL_MS,
  NAVER_CATEGORY_MAX_POLLS,
  harvestNaverCategoriesInPage,
  harvestNaverCategories,
  logNaverCategoriesJsonLines,
  harvestNaverSubjectsInPage,
  harvestNaverSubjects,
  logNaverSubjectsJsonLines,
};
