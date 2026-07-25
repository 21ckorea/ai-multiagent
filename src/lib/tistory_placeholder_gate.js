'use strict';

/**
 * @file tistory_placeholder_gate.js
 * @description 티스토리 이미지 플레이스홀더 처리 게이트웨이
 * @purpose  에디터에 삽입된 이미지 플레이스홀더({이미지 삽입공간})를 감지하고
 *           Gemini 이미지 생성 → 업로드 → 교체 흐름을 총괄하는 오케스트레이터.
 * @exports  processImagePlaceholders, waitForPlaceholderImages
 * @seeAlso  tistory_placeholder_util.js, gemini_image.js
 */


const { installTistoryPlaceholderUtilMain } = require('./tistory_placeholder_util');
const { installTistoryCoverResetMain } = require('./tistory_cover_reset');
const {
  installTistoryCoverAttachMain,
  COVER_UPLOAD_WAIT_BEFORE_PUBLISH_MS,
} = require('./tistory_cover_attach');

const GATE_MIN_VERSION = 3;

/**
 * MAIN-world placeholder gate — jably_blog/lib/tistory-placeholder-gate-main.js parity.
 */
function installTistoryPlaceholderGateMain() {
  if (
    window.__jablyTistoryPlaceholderGate &&
    (window.__jablyTistoryPlaceholderGate.__gateVersion ?? 0) >= GATE_MIN_VERSION
  ) {
    return;
  }

  const GATE_VERSION = 6;
  const PLACEHOLDER_LABEL_RE = /이미지\s*삽입\s*공간/i;
  const util = () => window.__jablyTistoryPlaceholderUtil;
  const PLACEHOLDER_RE = util()?.PLACEHOLDER_PLAIN_MATCH_RE || PLACEHOLDER_LABEL_RE;
  const PLACEHOLDER_RE_G =
    util()?.TISTORY_PLACEHOLDER_HTML_STRIP_RE_G ||
    /[^\n<]*이미지\s*삽입\s*공간[\s\S]*?(?=(?:<\/(?:div|p|section)>|<|$))/gi;
  const BLOCK_SEL =
    'p, div, section, article, header, footer, aside, li, td, th, blockquote, figcaption, h1, h2, h3, h4, h5, h6';
  const GATE_MAX_ATTEMPTS = 5;
  const GATE_RETRY_MS = 320;

  function log(...args) {
    console.log('[ja_test][TistoryPlaceholderGate]', ...args);
  }

  function warn(...args) {
    console.warn('[ja_test][TistoryPlaceholderGate]', ...args);
  }

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

  function getTinymceBody() {
    const sels = [
      'iframe.tox-edit-area__iframe',
      'iframe#editor-tistory_ifr',
      'iframe[id^="tistory_"]',
      'iframe.mce-edit-area',
    ];
    for (const s of sels) {
      const fr = document.querySelector(s);
      const doc = fr?.contentDocument || fr?.contentWindow?.document;
      if (doc?.body) {
        return doc.body;
      }
    }
    for (const fr of document.querySelectorAll('iframe')) {
      const doc = fr.contentDocument || fr.contentWindow?.document;
      const b = doc?.body;
      if (b?.classList?.contains('mce-content-body') || b?.getAttribute('id') === 'tinymce') {
        return b;
      }
    }
    return null;
  }

  function getTinymceEditorForBody(bodyEl) {
    try {
      const w = bodyEl?.ownerDocument?.defaultView;
      if (!w) return null;
      const topWin = w.top || w;
      const tm = topWin.tinymce || w.tinymce;
      if (!tm || !tm.editors) return null;
      const raw = tm.editors;
      const list = Array.isArray(raw)
        ? raw
        : Object.keys(raw)
            .map((k) => raw[k])
            .filter(Boolean);
      for (let i = 0; i < list.length; i += 1) {
        const ed = list[i];
        if (ed && typeof ed.getBody === 'function' && ed.getBody() === bodyEl) {
          return ed;
        }
      }
      if (tm.activeEditor && tm.activeEditor.getBody?.() === bodyEl) {
        return tm.activeEditor;
      }
    } catch (e) {
      log('getTinymceEditorForBody err', e);
    }
    return null;
  }

  function depthUnderRoot(body, el) {
    let d = 0;
    let x = el;
    while (x && x !== body) {
      d += 1;
      x = x.parentElement;
    }
    return d;
  }

  function findTightestBlockWithLabel(body) {
    const candidates = [];
    for (const el of body.querySelectorAll(BLOCK_SEL)) {
      const t = (el.textContent || '').replace(/\u200b/g, '');
      if (!PLACEHOLDER_LABEL_RE.test(t)) continue;
      candidates.push({ el, len: t.length, depth: depthUnderRoot(body, el) });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
      if (a.len !== b.len) return a.len - b.len;
      if (a.depth !== b.depth) return b.depth - a.depth;
      const cmp = a.el.compareDocumentPosition(b.el);
      if (cmp & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (cmp & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
    return candidates[0].el;
  }

  function pruneEmptyAncestors(body, startEl) {
    let el = startEl;
    while (el && el !== body) {
      const t = (el.textContent || '').replace(/\u200b/g, '').trim();
      const hasMedia = el.querySelector('img, video, iframe, table, svg');
      if (t.length > 0 || hasMedia) break;
      const parent = el.parentElement;
      try {
        el.remove();
      } catch {
        break;
      }
      el = parent;
    }
  }

  function countInText(text) {
    const u = util();
    const s = (text || '').replace(/\u200b/g, '');
    if (u?.countTistoryPlaceholdersInPlain) return u.countTistoryPlaceholdersInPlain(s);
    return PLACEHOLDER_LABEL_RE.test(s) ? (s.match(/이미지\s*삽입\s*공간/gi) || []).length : 0;
  }

  function countInHtml(html) {
    const u = util();
    if (u) return u.countTistoryPlaceholdersInHtml(html);
    return countInText(
      String(html || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' '),
    );
  }

  function countPlaceholders() {
    const body = getTinymceBody();
    const cm = findBodyCodeMirror();
    let tinymceCount = 0;
    let cmCount = 0;
    if (body) tinymceCount = countInText(body.textContent);
    if (cm) {
      try {
        cmCount = countInHtml(cm.getValue());
      } catch {
        /* ignore */
      }
    }
    return Math.max(tinymceCount, cmCount);
  }

  function stripCodeMirrorPlaceholders() {
    const cm = findBodyCodeMirror();
    if (!cm) return 0;
    let v = cm.getValue() || '';
    const before = countInHtml(v);
    if (before === 0) return 0;
    const u = util();
    if (u) {
      v = u.stripTistoryPlaceholderMarkupFromHtml(v);
    } else {
      PLACEHOLDER_RE_G.lastIndex = 0;
      v = v.replace(PLACEHOLDER_RE_G, '');
      v = v.replace(/<(div|p)[^>]*>\s*<\/\1>/gi, '');
    }
    try {
      cm.setValue(v);
      if (typeof cm.refresh === 'function') cm.refresh();
    } catch (e) {
      log('CodeMirror strip err', e);
    }
    return before;
  }

  function regexFallbackStripTinyMce() {
    const body = getTinymceBody();
    if (!body) return 0;
    const before = countInText(body.textContent);
    if (before === 0) return 0;
    let html = body.innerHTML || '';
    const u = util();
    if (u) {
      html = u.stripTistoryPlaceholderMarkupFromHtml(html);
    } else {
      PLACEHOLDER_RE_G.lastIndex = 0;
      html = html.replace(PLACEHOLDER_RE_G, '');
      html = html.replace(/<(div|p)[^>]*>\s*<\/\1>/gi, '');
    }
    try {
      const ed = getTinymceEditorForBody(body);
      if (ed && typeof ed.setContent === 'function') {
        ed.setContent(html);
        if (typeof ed.nodeChanged === 'function') ed.nodeChanged();
      } else {
        body.innerHTML = html;
      }
      body.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (e) {
      log('TinyMCE regex fallback err', e);
    }
    return before;
  }

  function syncTinymceFromCodeMirror() {
    const cm = findBodyCodeMirror();
    const body = getTinymceBody();
    if (!cm || !body) return;
    try {
      const v = cm.getValue() || '';
      const ed = getTinymceEditorForBody(body);
      if (ed && typeof ed.setContent === 'function') {
        ed.setContent(v);
        if (typeof ed.nodeChanged === 'function') ed.nodeChanged();
      }
    } catch (e) {
      log('syncTinymceFromCodeMirror err', e);
    }
  }

  function clearTinyMcePlaceholders() {
    const body = getTinymceBody();
    if (!body) return 0;
    let removed = 0;
    for (let iter = 0; iter < 24; iter += 1) {
      const raw = (body.textContent || '').replace(/\u200b/g, '');
      if (!PLACEHOLDER_LABEL_RE.test(raw)) break;
      const hit = findTightestBlockWithLabel(body);
      if (!hit?.parentNode) break;
      const parent = hit.parentElement;
      try {
        const hitLen = (hit.textContent || '').trim().length;
        if (hitLen > 150) {
          const re = /\[?\s*이미지\s*삽입\s*공간[^\n\]}]*[\]}]?/gi;
          hit.innerHTML = hit.innerHTML.replace(re, '');
        } else {
          hit.remove();
        }
      } catch (e) {
        log('remove block err', e);
        break;
      }
      if (parent && parent !== body) pruneEmptyAncestors(body, parent);
      removed += 1;
    }
    try {
      body.dispatchEvent(new Event('input', { bubbles: true }));
    } catch {
      /* ignore */
    }
    return removed;
  }

  function clearAllPlaceholders() {
    const cmStripped = stripCodeMirrorPlaceholders();
    syncTinymceFromCodeMirror();
    const domRemoved = clearTinyMcePlaceholders();
    regexFallbackStripTinyMce();
    stripCodeMirrorPlaceholders();
    const remaining = countPlaceholders();
    const result = { cmStripped, domRemoved, remaining };
    log('clearAllPlaceholders', result);
    return result;
  }

  async function runPrePublishGateStrict() {
    const before = countPlaceholders();
    if (before <= 0) {
      return { ok: true, before: 0, removed: 0, remaining: 0, attempts: 0 };
    }

    let removed = 0;
    for (let attempt = 1; attempt <= GATE_MAX_ATTEMPTS; attempt += 1) {
      const r = clearAllPlaceholders();
      removed += r.domRemoved + (r.cmStripped > 0 ? r.cmStripped : 0);
      const remaining = countPlaceholders();
      log('runPrePublishGateStrict attempt', { attempt, before, removed, remaining });
      if (remaining <= 0) {
        return { ok: true, before, removed, remaining: 0, attempts: attempt };
      }
      if (attempt < GATE_MAX_ATTEMPTS) {
        await new Promise((resolve) => window.setTimeout(resolve, GATE_RETRY_MS));
      }
    }

    const remaining = countPlaceholders();
    const out = { ok: remaining <= 0, before, removed, remaining, attempts: GATE_MAX_ATTEMPTS };
    if (!out.ok) warn('runPrePublishGateStrict — placeholders remain', out);
    return out;
  }

  function dispatchClickChain(el) {
    if (!el) return;
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    } catch {
      /* ignore */
    }
    try {
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    } catch {
      /* ignore */
    }
    try {
      el.click();
    } catch (e) {
      log('click err', e);
    }
  }

  async function selectCategory(id) {
    if (!id || !id.startsWith('category-item-')) return;
    const btn = document.querySelector('#category-btn');
    if (!btn) return;
    try {
      btn.click();
    } catch {
      return;
    }
    for (let i = 0; i < 85; i += 1) {
      await new Promise((r) => window.setTimeout(r, 120));
      const el = document.getElementById(id);
      const list = document.querySelector('#category-list');
      if (el && list && list.contains(el)) {
        dispatchClickChain(el);
        await new Promise((r) => window.setTimeout(r, 320));
        return;
      }
    }
  }

  function publishLayerFlow(visibility, categoryItemId, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const layerOpenDelayMs = typeof o.layerOpenDelayMs === 'number' ? o.layerOpenDelayMs : 4000;

    try {
      window.alert = function alertStub() {};
      window.confirm = function confirmStub() {
        return true;
      };
    } catch {
      /* ignore */
    }

    async function publishFlow() {
      if (categoryItemId) {
        try {
          await selectCategory(categoryItemId);
        } catch (e) {
          log('category err', e);
        }
      }

      let layerAttempts = 0;
      function openLayer() {
        layerAttempts += 1;
        const btn = document.querySelector('#publish-layer-btn');
        log('#publish-layer-btn attempt', layerAttempts, !!btn);
        if (btn) {
          btn.focus();
          btn.click();
          window.setTimeout(applyRadio, 750);
          return;
        }
        if (layerAttempts < 55) window.setTimeout(openLayer, 300);
      }

      function clickVisibilityRadio(selector, label) {
        const inp = document.querySelector(selector);
        if (!inp) {
          warn('visibility radio missing', { label, selector });
          return false;
        }
        if (inp.checked) {
          log('visibility radio already selected', { label, selector });
          return true;
        }
        inp.focus();
        inp.click();
        if (!inp.checked) {
          const forLabel = document.querySelector(`label[for="${inp.id}"]`);
          if (forLabel) {
            forLabel.click();
          }
        }
        log('visibility radio clicked', { label, selector, checked: inp.checked });
        return inp.checked;
      }

      function applyRadio() {
        try {
          window.__jablyTistoryCoverReset?.reset?.();
        } catch {
          /* ignore */
        }
        
        // visibility가 '2' 또는 true 이면 공개, '1'이면 보호, '0' 또는 false 이면 비공개
        if (visibility === '2' || visibility === true || visibility === 'public') {
          clickVisibilityRadio('#open20', 'public');
        } else if (visibility === '1' || visibility === 'protected') {
          clickVisibilityRadio('#open10', 'protected');
        } else {
          clickVisibilityRadio('#open0', 'private');
        }

        window.setTimeout(() => {
          void clickSubmit();
        }, 500);
      }

      let submitAttempts = 0;
      function capturePublishPreviewUrl() {
        try {
          const slug = (document.querySelector('#urlPublish')?.value || '').trim();
          const prefixEl =
            document.querySelector('.publish_editor span.txt_g') ||
            document.querySelector('.info_editor span.txt_g') ||
            document.querySelector('span.txt_g');
          const prefix = (prefixEl?.textContent || '').trim();
          if (!slug || !prefix) {
            return;
          }
          const base = prefix.replace(/\s+/g, '');
          const href = slug.startsWith('http')
            ? slug
            : new URL(slug, base.endsWith('/') ? base : `${base}/`).href;
          if (href && /\.tistory\.com/i.test(href)) {
            window.__jablyTistoryLastPublishPreviewUrl = href;
            log('publish preview URL captured', { href: href.slice(0, 120) });
          }
        } catch (e) {
          warn('capturePublishPreviewUrl err', e);
        }
      }

      async function clickSubmit() {
        submitAttempts += 1;
        const btn = document.querySelector('#publish-btn');
        log('#publish-btn attempt', submitAttempts, !!btn);
        if (btn) {
          capturePublishPreviewUrl();
          if (typeof runPrePublishGateStrict !== 'function') {
            warn('publish blocked — placeholder gate missing');
            return;
          }
          try {
            const gate = await runPrePublishGateStrict();
            log('pre-publish gate strict', gate);
            if (!gate.ok) {
              warn('publish blocked — placeholders remain', gate);
              return;
            }
          } catch (e) {
            warn('pre-publish gate err — publish blocked', e);
            return;
          }
          const coverUrl = typeof o.coverDataUrl === 'string' ? o.coverDataUrl : '';
          const coverWaitMs =
            typeof o.coverUploadWaitMs === 'number' && o.coverUploadWaitMs >= 0
              ? o.coverUploadWaitMs
              : 3500;
          if (coverUrl.startsWith('data:image')) {
            log('cover upload wait start', { ms: coverWaitMs, prefix: coverUrl.slice(0, 48) });
            try {
              const attachFn = window.__jablyTistoryCoverAttach?.attach;
              if (typeof attachFn === 'function') {
                const coverRet = await attachFn(coverUrl);
                log('cover attach result', coverRet);
              } else {
                warn('cover attach skipped — __jablyTistoryCoverAttach missing');
              }
            } catch (e) {
              warn('cover attach err', e);
            }
            await new Promise((r) => window.setTimeout(r, coverWaitMs));
          }
          log('#publish-btn click', { attempt: submitAttempts });
          btn.focus();
          btn.click();
          return;
        }
        if (submitAttempts < 45) window.setTimeout(() => void clickSubmit(), 280);
      }

      window.setTimeout(openLayer, layerOpenDelayMs);
    }

    void publishFlow();
  }

  window.__jablyTistoryPlaceholderGate = {
    __gateVersion: GATE_VERSION,
    countPlaceholders,
    clearAllPlaceholders,
    runPrePublishGateStrict,
    publishLayerFlow,
  };
}

function logGateJsonLine(logger, payload) {
  const body = {
    ok: payload?.ok === true,
    before: payload?.before ?? 0,
    removed: payload?.removed ?? 0,
    remaining: payload?.remaining ?? 0,
    attempts: payload?.attempts ?? 0,
  };
  if (payload?.error) {
    body.error = payload.error;
  }
  logger?.info(`[Tistory] [GATE] ${JSON.stringify(body)}`);
  return body;
}

/**
 * @param {import('playwright').Page} page
 */
async function injectTistoryPlaceholderGate(page) {
  await page.evaluate(installTistoryPlaceholderUtilMain);
  await page.evaluate(installTistoryCoverResetMain);
  await page.evaluate(installTistoryCoverAttachMain);
  await page.evaluate(installTistoryPlaceholderGateMain);
}

async function isPlaceholderGateReady(page) {
  return page.evaluate(
    (minVersion) =>
      typeof window.__jablyTistoryPlaceholderGate?.runPrePublishGateStrict === 'function' &&
      (window.__jablyTistoryPlaceholderGate?.__gateVersion ?? 0) >= minVersion,
    GATE_MIN_VERSION,
  );
}

/**
 * bg-tistory-kakao-flow.js runPrePublishPlaceholderGateOnTab parity.
 * @param {import('playwright').Page} page
 */
async function runPrePublishPlaceholderGateOnPage(page, logger) {
  const ready = await isPlaceholderGateReady(page);
  if (!ready) {
    await injectTistoryPlaceholderGate(page);
    const afterInject = await isPlaceholderGateReady(page);
    if (!afterInject) {
      const fail = { ok: false, error: 'gate_inject_failed', before: 0, removed: 0, remaining: 0, attempts: 0 };
      logGateJsonLine(logger, fail);
      return fail;
    }
  }

  const result = await page.evaluate(async () => {
    const fn = window.__jablyTistoryPlaceholderGate?.runPrePublishGateStrict;
    if (typeof fn !== 'function') {
      return { ok: false, error: 'no_gate_fn', before: 0, removed: 0, remaining: 0, attempts: 0 };
    }
    return fn();
  });

  logGateJsonLine(logger, result);
  return result;
}

/**
 * Trigger publish layer flow with gate (after image paste or direct publish).
 * @param {import('playwright').Page} page
 */
async function triggerTistoryPublishLayerFlow(page, publishOpts = {}, logger) {
  const gate = await runPrePublishPlaceholderGateOnPage(page, logger);
  if (!gate.ok) {
    return { ok: false, reason: 'placeholder_gate_failed', gate };
  }

  const coverDataUrl = String(publishOpts.coverDataUrl || '').trim();
  await page.evaluate(
    ({ visibility, categoryItemId, layerOpenDelayMs, coverDataUrl: coverUrl, coverUploadWaitMs }) => {
      window.__jablyTistoryPlaceholderGate?.publishLayerFlow?.(visibility, categoryItemId, {
        layerOpenDelayMs,
        coverDataUrl: coverUrl,
        coverUploadWaitMs,
      });
    },
    {
      visibility: publishOpts.visibility,
      categoryItemId: String(publishOpts.categoryItemElementId || publishOpts.categoryItemId || '').trim(),
      layerOpenDelayMs: publishOpts.layerOpenDelayMs ?? 500,
      coverDataUrl,
      coverUploadWaitMs:
        publishOpts.coverUploadWaitMs != null
          ? publishOpts.coverUploadWaitMs
          : COVER_UPLOAD_WAIT_BEFORE_PUBLISH_MS,
    },
  );

  logger?.info(
    'Tistory publish layer flow triggered (gate passed); navigation/harvest handled by harvestPublishedPost',
  );
  return { ok: true, gate };
}

module.exports = {
  GATE_MIN_VERSION,
  COVER_UPLOAD_WAIT_BEFORE_PUBLISH_MS,
  installTistoryPlaceholderGateMain,
  injectTistoryPlaceholderGate,
  isPlaceholderGateReady,
  runPrePublishPlaceholderGateOnPage,
  triggerTistoryPublishLayerFlow,
  logGateJsonLine,
};
