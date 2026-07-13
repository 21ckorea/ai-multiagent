'use strict';

/**
 * @deprecated 이 파일은 _legacy/ 폴더로 이동된 미사용/레거시 파일입니다.
 * @reason    Selenium 구버전이거나 디버그 전용 또는 수동 실행 스크립트로,
 *            현재 Playwright 기반 파이프라인에서 직접 사용하지 않습니다.
 * @warning   삭제 전 보관 중. 필요시 _legacy/ 에서 복원 가능.
 */


const fs = require('fs');
const path = require('path');

function isGeminiImageDebugEnabled() {
  return (
    process.env.JA_GEMINI_IMAGE_DEBUG === '1' ||
    process.env.JA_GEMINI_COMPOSE_DEBUG === '1' ||
    process.env.JA_DEBUG === '1'
  );
}

async function probeGeminiImageDom(page) {
  try {
    return await page.evaluate(() => {
      const overlays = document.querySelectorAll('div.overlay-container').length;
      const copyBtn = document.querySelector('button.copy-button[aria-label="이미지 복사"]');
      const sendStop = [...document.querySelectorAll('button[aria-label]')].some((b) =>
        /중지|Stop generating/i.test(b.getAttribute('aria-label') || ''),
      );
      return {
        href: location.href,
        overlayCount: overlays,
        hasCopyButton: !!copyBtn,
        sendLikelyActive: sendStop,
        qlEditorCount: document.querySelectorAll('div.ql-editor').length,
        imageEvents: Array.isArray(window.__jablyGeminiImageDebug?.events)
          ? window.__jablyGeminiImageDebug.events.slice(-16)
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
 * @returns {Promise<string|null>}
 */
async function dumpGeminiImageSnapshot(page, logger, options = {}) {
  if (!isGeminiImageDebugEnabled()) {
    return null;
  }

  const label = options.label || 'image';
  const snapshot = {
    label,
    capturedAt: new Date().toISOString(),
    pageUrl: page.url(),
    queueIndex: options.queueIndex ?? null,
    restartCount: options.restartCount ?? null,
    fillResult: options.fillResult ?? null,
    dom: await probeGeminiImageDom(page),
  };

  const dir = path.resolve(process.cwd(), 'build');
  fs.mkdirSync(dir, { recursive: true });
  const fileName = `gemini-image-debug-${label.replace(/[^\w.-]+/g, '_')}-${Date.now()}.json`;
  const outPath = path.join(dir, fileName);
  fs.writeFileSync(outPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');

  logger?.info?.(`[GeminiImage] debug snapshot written: ${outPath}`);
  return outPath;
}

module.exports = {
  isGeminiImageDebugEnabled,
  dumpGeminiImageSnapshot,
  probeGeminiImageDom,
};
