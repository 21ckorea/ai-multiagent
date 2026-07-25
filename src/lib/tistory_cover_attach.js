'use strict';

/**
 * @file tistory_cover_attach.js
 * @description 티스토리 대표이미지(커버) 첨부 자동화
 * @purpose  생성된 썸네일 이미지를 티스토리 포스트의 대표이미지로 자동 첨부.
 *           에디터 내 커버 이미지 업로드 UI를 Playwright로 제어.
 * @exports  attachTistoryCoverImage
 * @seeAlso  tistory_cover_reset.js, tistory_editor_inject.js
 */


/** bg-tistory-kakao-flow.js COVER_UPLOAD_WAIT_BEFORE_PUBLISH_MS */
const COVER_UPLOAD_WAIT_BEFORE_PUBLISH_MS = 3500;

/**
 * MAIN-world installer — attach fn inlined (Playwright evaluate serializes one function only).
 */
function installTistoryCoverAttachMain() {
  if (window.__jablyTistoryCoverAttach) {
    return;
  }

  async function attach(dataUrl) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const url = String(dataUrl || '');
    if (!url.startsWith('data:image')) {
      return { ok: false, reason: 'not_data_image_url' };
    }

    let inp = null;
    for (let i = 0; i < 30; i += 1) {
      inp =
        document.querySelector('input.inp_g[type="file"]') ||
        document.querySelector('input.inp_g[accept*="image"]') ||
        document.querySelector('input.inp_g');
      if (inp) break;
      await sleep(100);
    }
    if (!inp) {
      return { ok: false, reason: 'inp_g_not_found' };
    }

    try {
      const resetFn = window.__jablyTistoryCoverReset?.reset;
      if (typeof resetFn === 'function') {
        resetFn();
      } else {
        inp.value = '';
        const emptyDt = new DataTransfer();
        const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files');
        if (desc && typeof desc.set === 'function') {
          desc.set.call(inp, emptyDt.files);
        } else {
          inp.files = emptyDt.files;
        }
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } catch {
      /* ignore */
    }

    let blob;
    try {
      const res = await fetch(url);
      blob = await res.blob();
    } catch {
      return { ok: false, reason: 'cover_fetch_failed' };
    }

    const mime = blob.type || 'image/png';
    let ext = 'png';
    if (/jpe?g/i.test(mime)) ext = 'jpg';
    else if (/webp/i.test(mime)) ext = 'webp';
    else if (/gif/i.test(mime)) ext = 'gif';
    const file = new File([blob], `thumbnail.${ext}`, { type: mime, lastModified: Date.now() });

    function hasFiles() {
      try {
        return inp.files && inp.files.length > 0;
      } catch {
        return false;
      }
    }

    function setFilesViaNativePrototype(filesList) {
      const dt = new DataTransfer();
      for (let i = 0; i < filesList.length; i += 1) {
        try {
          dt.items.add(filesList[i]);
        } catch {
          return false;
        }
      }
      const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files');
      if (desc && typeof desc.set === 'function') {
        try {
          desc.set.call(inp, dt.files);
          return true;
        } catch {
          /* fall through */
        }
      }
      try {
        inp.files = dt.files;
        return true;
      } catch {
        return false;
      }
    }

    function dispatchCoverFileCommitted(fileObj) {
      try {
        inp.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            inputType: 'insertFromPaste',
            data: fileObj?.name ?? '',
          }),
        );
      } catch {
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      }
      try {
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      } catch {
        /* ignore */
      }
      try {
        inp.dispatchEvent(new Event('blur', { bubbles: true }));
      } catch {
        /* ignore */
      }
    }

    function simulateFileDropOn(target) {
      if (!target || typeof target.dispatchEvent !== 'function') return false;
      const dt = new DataTransfer();
      try {
        dt.items.add(file);
      } catch {
        return false;
      }
      const base = { bubbles: true, cancelable: true, dataTransfer: dt, view: window };
      try {
        target.dispatchEvent(new DragEvent('dragenter', base));
        const over = new DragEvent('dragover', base);
        over.preventDefault();
        target.dispatchEvent(over);
        const drop = new DragEvent('drop', base);
        drop.preventDefault();
        target.dispatchEvent(drop);
        return true;
      } catch {
        return false;
      }
    }

    function collectDropTargets(input) {
      const out = [];
      const seen = new Set();
      const push = (el) => {
        if (el && !seen.has(el)) {
          seen.add(el);
          out.push(el);
        }
      };
      push(input);
      let labeled = null;
      if (input.id) {
        try {
          const id = String(input.id);
          const esc =
            typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
              ? CSS.escape(id)
              : id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          labeled = document.querySelector(`label[for="${esc}"]`);
        } catch {
          labeled = null;
        }
      }
      push(labeled);
      let p = input.parentElement;
      for (let d = 0; d < 8 && p; d += 1) {
        push(p);
        p = p.parentElement;
      }
      return out;
    }

    try {
      inp.focus({ preventScroll: true });
    } catch {
      try {
        inp.focus();
      } catch {
        /* ignore */
      }
    }
    await sleep(60 + Math.floor(Math.random() * 50));

    const targets = collectDropTargets(inp);
    for (const el of targets) {
      simulateFileDropOn(el);
      await sleep(40);
      if (hasFiles()) {
        dispatchCoverFileCommitted(file);
        return { ok: true, via: 'drop', ext, bytes: blob.size };
      }
    }

    await sleep(80);
    if (setFilesViaNativePrototype([file]) && hasFiles()) {
      dispatchCoverFileCommitted(file);
      return { ok: true, via: 'native_files', ext, bytes: blob.size };
    }

    return { ok: false, reason: 'cover_attach_failed', ext };
  }

  window.__jablyTistoryCoverAttach = { attach };
}

/** Invoke installed attach from Node after installTistoryCoverAttachMain. */
async function invokeTistoryCoverAttachMain(url) {
  const fn = window.__jablyTistoryCoverAttach?.attach;
  if (typeof fn !== 'function') {
    return { ok: false, reason: 'no_attach_fn' };
  }
  return fn(url);
}

/**
 * @param {import('playwright').Page} page
 * @param {string} dataUrl
 * @param {object} [logger]
 */
async function attachTistoryCoverImageOnPage(page, dataUrl, logger) {
  const url = String(dataUrl || '');
  if (!url.startsWith('data:image')) {
    logger?.info?.('[Tistory] [COVER_ATTACH] skip — no data:image URL');
    return { ok: false, reason: 'not_data_image_url' };
  }

  await page.evaluate(installTistoryCoverAttachMain);
  let result = await page.evaluate(invokeTistoryCoverAttachMain, url);
  if (result && typeof result.then === 'function') {
    result = await result;
  }
  logger?.info?.(`[Tistory] [COVER_ATTACH] ${JSON.stringify(result || { ok: false })}`);
  return result || { ok: false, reason: 'no_result' };
}

module.exports = {
  COVER_UPLOAD_WAIT_BEFORE_PUBLISH_MS,
  installTistoryCoverAttachMain,
  invokeTistoryCoverAttachMain,
  attachTistoryCoverImageOnPage,
};
