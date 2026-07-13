'use strict';

/**
 * @deprecated 이 파일은 _legacy/ 폴더로 이동된 미사용/레거시 파일입니다.
 * @reason    Selenium 구버전이거나 디버그 전용 또는 수동 실행 스크립트로,
 *            현재 Playwright 기반 파이프라인에서 직접 사용하지 않습니다.
 * @warning   삭제 전 보관 중. 필요시 _legacy/ 에서 복원 가능.
 */


const fs = require('fs');
const path = require('path');

function isGeminiComposeDebugEnabled() {
  return process.env.JA_GEMINI_COMPOSE_DEBUG === '1' || process.env.JA_DEBUG === '1';
}

async function probeComposerLocator(frame, selector) {
  const entry = { selector, count: 0, visible: false };
  try {
    const locator = frame.locator(selector);
    entry.count = await locator.count();
    if (entry.count === 0) {
      return entry;
    }
    const target = locator.first();
    entry.visible = await target.isVisible({ timeout: 500 }).catch(() => false);
    entry.box = await target.boundingBox().catch(() => null);
    entry.tagName = await target.evaluate((el) => el.tagName?.toLowerCase() || '').catch(() => '');
    entry.role = await target.getAttribute('role').catch(() => null);
    entry.ariaLabel = await target.getAttribute('aria-label').catch(() => null);
    entry.contentEditable = await target
      .getAttribute('contenteditable')
      .catch(() => null);
    const text = await target.innerText({ timeout: 1000 }).catch(() => '');
    entry.innerTextHead = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  } catch (error) {
    entry.error = error instanceof Error ? error.message : String(error);
  }
  return entry;
}

async function probeFrameDom(frame) {
  try {
    return await frame.evaluate(() => {
      function summarize(el) {
        if (!el) {
          return null;
        }
        const rect = el.getBoundingClientRect();
        return {
          tag: el.tagName?.toLowerCase() || '',
          role: el.getAttribute('role'),
          ariaLabel: el.getAttribute('aria-label'),
          testId: el.getAttribute('data-test-id'),
          contentEditable: el.getAttribute('contenteditable'),
          className: (el.className || '').toString().slice(0, 120),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        };
      }

      const qlEditors = [...document.querySelectorAll('div.ql-editor')].slice(0, 8).map(summarize);
      const richTextareas = [...document.querySelectorAll('rich-textarea')].slice(0, 8).map(summarize);
      const promptAreas = [...document.querySelectorAll('[data-test-id="prompt-textarea"]')]
        .slice(0, 4)
        .map(summarize);
      const sendButtons = [...document.querySelectorAll('button.send-button')]
        .slice(0, 4)
        .map((el) => ({
          ...summarize(el),
          ariaDisabled: el.getAttribute('aria-disabled'),
        }));

      return {
        href: location.href,
        title: document.title,
        qlEditorCount: document.querySelectorAll('div.ql-editor').length,
        richTextareaCount: document.querySelectorAll('rich-textarea').length,
        qlEditors,
        richTextareas,
        promptAreas,
        sendButtons,
        geminiApp: !!document.querySelector('gemini-app'),
        chatWindow: !!document.querySelector('chat-window'),
      };
    });
  } catch (error) {
    return {
      href: frame.url(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Writes a JSON snapshot of Gemini compose-related DOM/locators (debug only).
 * @returns {Promise<string|null>} absolute path written
 */
async function dumpGeminiComposePage(page, logger, options = {}) {
  if (!isGeminiComposeDebugEnabled()) {
    return null;
  }

  const selectors = options.selectors || [];
  const label = options.label || 'compose';
  const snapshot = {
    label,
    capturedAt: new Date().toISOString(),
    pageUrl: page.url(),
    frames: [],
  };

  for (const frame of page.frames()) {
    const frameEntry = {
      url: frame.url(),
      name: frame.name(),
      locators: [],
      dom: await probeFrameDom(frame),
    };
    for (const selector of selectors) {
      frameEntry.locators.push(await probeComposerLocator(frame, selector));
    }
    snapshot.frames.push(frameEntry);
  }

  const dir = path.resolve(process.cwd(), 'build');
  fs.mkdirSync(dir, { recursive: true });
  const fileName = `gemini-compose-debug-${label.replace(/[^\w.-]+/g, '_')}-${Date.now()}.json`;
  const outPath = path.join(dir, fileName);
  fs.writeFileSync(outPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');

  logger?.info?.(`[GeminiDebug] compose snapshot written: ${outPath}`);
  return outPath;
}

module.exports = {
  isGeminiComposeDebugEnabled,
  dumpGeminiComposePage,
};
