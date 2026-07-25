'use strict';

/**
 * @deprecated 이 파일은 _legacy/ 폴더로 이동된 미사용/레거시 파일입니다.
 * @reason    Selenium 구버전이거나 디버그 전용 또는 수동 실행 스크립트로,
 *            현재 Playwright 기반 파이프라인에서 직접 사용하지 않습니다.
 * @warning   삭제 전 보관 중. 필요시 _legacy/ 에서 복원 가능.
 */


const fs = require('fs');
const path = require('path');

function isTistoryInjectDebugEnabled() {
  return process.env.JA_TISTORY_INJECT_DEBUG === '1' || process.env.JA_DEBUG === '1';
}

async function probeEditorLocator(page, selector) {
  const entry = { selector, count: 0, visible: false };
  try {
    const locator = page.locator(selector);
    entry.count = await locator.count();
    if (entry.count === 0) {
      return entry;
    }
    const target = locator.first();
    entry.visible = await target.isVisible({ timeout: 500 }).catch(() => false);
    entry.box = await target.boundingBox().catch(() => null);
    entry.tagName = await target.evaluate((el) => el.tagName?.toLowerCase() || '').catch(() => '');
    entry.textHead = await target
      .innerText({ timeout: 1000 })
      .catch(() => '')
      .then((text) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 80));
  } catch (error) {
    entry.error = error instanceof Error ? error.message : String(error);
  }
  return entry;
}

async function probeEditorDom(page) {
  try {
    return await page.evaluate(() => {
      function findBodyCodeMirror() {
        for (const ta of document.querySelectorAll('textarea')) {
          const sib = ta.nextElementSibling;
          if (sib?.classList?.contains('CodeMirror') && sib.CodeMirror) {
            return sib.CodeMirror;
          }
        }
        for (const node of document.querySelectorAll('.CodeMirror')) {
          if (node.CodeMirror && typeof node.CodeMirror.setValue === 'function') {
            return node.CodeMirror;
          }
        }
        return null;
      }

      const cm = findBodyCodeMirror();
      let cmChars = 0;
      let cmHead = '';
      if (cm) {
        try {
          const value = cm.getValue();
          cmChars = value.length;
          cmHead = value.slice(0, 120);
        } catch {
          /* ignore */
        }
      }

      const titleEl =
        document.querySelector('#post-title-inp') ||
        document.querySelector('textarea.textarea_tit');

      return {
        href: location.href,
        title: document.title,
        modeOpenBtn: !!document.querySelector('#editor-mode-layer-btn-open'),
        htmlModeItem: !!document.querySelector('#editor-mode-html'),
        codeMirrorNodes: document.querySelectorAll('.CodeMirror').length,
        hasBodyCodeMirror: !!cm,
        codeMirrorChars: cmChars,
        codeMirrorHead: cmHead,
        postTitleValue: titleEl ? String(titleEl.value || '').slice(0, 120) : '',
        categoryBtn: !!document.querySelector('#category-btn'),
        publishLayerBtn: !!document.querySelector('#publish-layer-btn'),
        gateReady:
          typeof window.__jablyTistoryPlaceholderGate?.runPrePublishGateStrict === 'function',
        coverResetReady: typeof window.__jablyTistoryCoverReset?.reset === 'function',
        injectDebugEvents: Array.isArray(window.__jablyTistoryInjectDebug?.events)
          ? window.__jablyTistoryInjectDebug.events.slice(-24)
          : [],
      };
    });
  } catch (error) {
    return {
      href: page.url(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Writes a JSON snapshot of Tistory newpost editor DOM (debug only).
 * @returns {Promise<string|null>} absolute path written
 */
async function dumpTistoryEditorSnapshot(page, logger, options = {}) {
  if (!isTistoryInjectDebugEnabled()) {
    return null;
  }

  const label = options.label || 'editor';
  const selectors = options.selectors || [
    '#editor-mode-layer-btn-open',
    '#editor-mode-html',
    '#category-btn',
    '#post-title-inp',
    '#publish-layer-btn',
    '#publish-btn',
    '.CodeMirror',
  ];

  const snapshot = {
    label,
    capturedAt: new Date().toISOString(),
    pageUrl: page.url(),
    openTabCount: options.openTabCount ?? null,
    waitResult: options.waitResult ?? null,
    readyResult: options.readyResult ?? null,
    playwrightMode: options.playwrightMode ?? null,
    locators: [],
    dom: await probeEditorDom(page),
  };

  for (const selector of selectors) {
    snapshot.locators.push(await probeEditorLocator(page, selector));
  }

  const dir = path.resolve(process.cwd(), 'build');
  fs.mkdirSync(dir, { recursive: true });
  const fileName = `tistory-inject-debug-${label.replace(/[^\w.-]+/g, '_')}-${Date.now()}.json`;
  const outPath = path.join(dir, fileName);
  fs.writeFileSync(outPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');

  logger?.info?.(`[TistoryInject] debug snapshot written: ${outPath}`);
  return outPath;
}

module.exports = {
  isTistoryInjectDebugEnabled,
  dumpTistoryEditorSnapshot,
  probeEditorDom,
};
