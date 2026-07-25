'use strict';

/**
 * @file tistory_cover_reset.js
 * @description 티스토리 대표이미지(커버) 초기화
 * @purpose  이전 포스트의 대표이미지가 남아 있을 경우 초기화하여
 *           새 이미지가 올바르게 첨부될 수 있도록 사전 정리.
 * @exports  resetTistoryCoverImage
 * @seeAlso  tistory_cover_attach.js
 */


/**
 * MAIN-world cover reset — jably_blog/lib/tistory-cover-reset-main.js parity.
 */
function installTistoryCoverResetMain() {
  if (window.__jablyTistoryCoverReset) {
    return;
  }

  function resetCoverFileInputs() {
    const inputs = document.querySelectorAll(
      'input.inp_g[type="file"], input.inp_g[accept*="image"], input.inp_g',
    );
    let n = 0;
    for (const inp of inputs) {
      try {
        inp.value = '';
        const emptyDt = new DataTransfer();
        const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files');
        if (desc && typeof desc.set === 'function') {
          desc.set.call(inp, emptyDt.files);
        } else {
          inp.files = emptyDt.files;
        }
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        n += 1;
      } catch {
        /* ignore */
      }
    }
    return n;
  }

  function clearCoverPreviewImages() {
    let removed = 0;
    const roots = [
      document.querySelector('#publish-layer'),
      document.querySelector('.layer_publish'),
      document.querySelector('[class*="publish_layer"]'),
      document.body,
    ].filter(Boolean);

    for (const root of roots) {
      const nearInp = root.querySelectorAll('input.inp_g');
      for (const inp of nearInp) {
        let el = inp.parentElement;
        for (let d = 0; d < 6 && el && el !== root; d += 1) {
          for (const img of el.querySelectorAll('img')) {
            try {
              img.removeAttribute('src');
              img.src = '';
              if (img.parentElement) {
                img.remove();
              }
              removed += 1;
            } catch {
              /* ignore */
            }
          }
          el = el.parentElement;
        }
      }
    }
    return removed;
  }

  function reset() {
    const inputs = resetCoverFileInputs();
    const previews = clearCoverPreviewImages();
    return { ok: true, inputs, previews };
  }

  window.__jablyTistoryCoverReset = { reset };
}

/**
 * @param {import('playwright').Page} page
 */
async function resetTistoryCoverThumbnailOnPage(page, logger) {
  await page.evaluate(installTistoryCoverResetMain);
  const result = await page.evaluate(() => {
    const fn = window.__jablyTistoryCoverReset?.reset;
    return typeof fn === 'function' ? fn() : { ok: false, error: 'no_reset_fn' };
  });
  logger?.info(
    `[Tistory] [COVER_RESET] ${JSON.stringify({
      ok: result?.ok === true,
      inputs: result?.inputs ?? 0,
      previews: result?.previews ?? 0,
    })}`,
  );
  return result;
}

module.exports = {
  installTistoryCoverResetMain,
  resetTistoryCoverThumbnailOnPage,
};
