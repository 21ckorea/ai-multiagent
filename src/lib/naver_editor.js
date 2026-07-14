'use strict';

/**
 * @file naver_editor.js
 * @description 네이버 블로그 에디터 자동화 (본문 입력, 서식)
 * @purpose  네이버 스마트에디터에 JSON 블록(summary/heading/paragraph/imgplace/tags)을
 *           파싱하여 서식·줄바꿈·하이라이트를 적용하며 삽입하는 핵심 에디터 모듈.
 * @exports  injectContentToNaverEditor, setNaverTitle, setNaverTags
 * @seeAlso  naver_common.js, naver_image.js, playwright_naver_publish.js
 */


const { sleep } = require('./common');
const { NAVER_PUBLISH_SELECTORS } = require('./naver_common');

const EDITOR_READY_TIMEOUT_MS = 45000;
const EDITOR_POLL_MS = 500;

function naverEditorProbeFrameMain() {
const hasWrap = !!(
document.querySelector('article.se-components-wrap') ||
document.querySelector('.se-components-wrap')
);
const dataA11yBodyGlobal = !!document.querySelector('[data-a11y-title="본문"]');
const seTextCount = document.querySelectorAll('.se-component.se-text').length;
const seDocumentTitle = !!document.querySelector('.se-component.se-documentTitle');
const score =
seTextCount * 25 +
(dataA11yBodyGlobal ? 2000 : 0) +
(seDocumentTitle ? 800 : 0) +
(hasWrap ? 100 : 0) +
(window !== window.top ? 50 : 0);
return {
href: typeof location !== 'undefined' ? location.href : '',
score,
probeFrame: {
hasWrap,
dataA11yBodyGlobal,
seTextCount,
seDocumentTitle,
},
};
}

function naverEditorCdpEnsureEditorReadyMain() {
const wrap =
document.querySelector('article.se-components-wrap') ||
document.querySelector('.se-components-wrap');
if (!wrap) return { ok: false, reason: 'no_wrap' };
const titleComp =
document.querySelector('.se-component.se-documentTitle') ||
document.querySelector('.se-documentTitle');
let bodyComp =
document.querySelector('.se-component.se-text[data-a11y-title="본문"]') ||
document.querySelector('[data-a11y-title="본문"]');
if (!titleComp && !bodyComp) return { ok: false, reason: 'no_fields' };
return { ok: true };
}

function naverEditorFocusFieldMain(which) {
const w = typeof which === 'string' ? which : '';
const wrap =
document.querySelector('article.se-components-wrap') ||
document.querySelector('.se-components-wrap');
if (!wrap) return { ok: false, reason: 'no_wrap' };

const titleComp =
document.querySelector('.se-component.se-documentTitle') ||
document.querySelector('.se-documentTitle');
let bodyComp =
document.querySelector('.se-component.se-text[data-a11y-title="본문"]') ||
document.querySelector('[data-a11y-title="본문"]');
if (!bodyComp) {
const list = wrap.querySelectorAll('.se-component.se-text');
bodyComp = list.length ? list[0] : null;
}

const comp = w === 'title' ? titleComp : bodyComp;
if (!comp) {
return { ok: false, reason: 'no_comp', which: w, hasTitle: !!titleComp, hasBody: !!bodyComp };
}

try {
comp.scrollIntoView({ block: 'center' });
} catch {
/* ignore */
}

const p = comp.querySelector('p.se-text-paragraph') || comp.querySelector('p');
const node = p?.querySelector('span.__se-node');
const editable =
p?.closest("[contenteditable='true']") ||
comp.querySelector("[contenteditable='true']") ||
p;
if (!editable) return { ok: false, reason: 'no_editable', which: w };

// Click the paragraph/node directly (not just the component wrapper) so the
// caret lands inside THIS field — title vs body share one editor region.
const clickTarget = node || p || comp;
try {
clickTarget.dispatchEvent(
new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }),
);
clickTarget.dispatchEvent(
new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }),
);
clickTarget.dispatchEvent(
new MouseEvent('click', { bubbles: true, cancelable: true, view: window }),
);
} catch {
/* ignore */
}

try {
node?.focus?.();
editable.focus?.();
} catch {
/* ignore */
}

try {
const target = node || p;
if (target) {
const r = document.createRange();
r.selectNodeContents(target);
r.collapse(false);
const sel = window.getSelection();
sel.removeAllRanges();
sel.addRange(r);
}
} catch {
/* ignore */
}

// Diagnostics: where did focus/selection actually land?
const ae = document.activeElement;
const sel = window.getSelection();
let anchorEl = null;
if (sel && sel.anchorNode) {
anchorEl = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
}
const inTitle = !!(anchorEl && anchorEl.closest && anchorEl.closest('.se-documentTitle'));
const inBody = !!(anchorEl && anchorEl.closest && anchorEl.closest('[data-a11y-title="본문"]'));

return {
ok: true,
which: w,
debug: {
compClass: comp.className,
hasNode: !!node,
editableTag: editable.tagName,
editableClass: typeof editable.className === 'string' ? editable.className : '',
activeEl: ae ? `${ae.tagName}.${(ae.className || '').toString().slice(0, 60)}` : '(none)',
anchorEl: anchorEl ? `${anchorEl.tagName}.${(anchorEl.className || '').toString().slice(0, 60)}` : '(none)',
caretInTitle: inTitle,
caretInBody: inBody,
},
};
}

function naverEditorOpenBodyContextMenuMain() {
const p =
document.querySelector('[data-a11y-title="본문"] p.se-text-paragraph') ||
document.querySelector('p.se-text-paragraph');
const node = p?.querySelector('span.__se-node') || p;
if (!node) return { ok: false, reason: 'no_target' };
const rect = node.getBoundingClientRect();
const x = rect.left + rect.width / 2;
const y = rect.top + Math.min(Math.max(rect.height / 2, 4), 120);
node.dispatchEvent(
new MouseEvent('contextmenu', {
bubbles: true,
cancelable: true,
view: window,
button: 2,
clientX: x,
clientY: y,
}),
);
return { ok: true };
}

function naverEditorClickContextMenuSelectAllMain() {
const btn =
document.querySelector('[data-log="ctm.selectall"]') ||
document.querySelector('.se-context-menu-button-select-all');
if (!btn) return { clicked: false };
btn.click();
return { clicked: true };
}

async function naverToolbarFormattingSequenceMain() {
const sleepLocal = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (sel) => document.querySelector(sel);
const fontDd = q('button[data-name="font-family"]');
if (!fontDd) return { applied: false, reason: 'no_font_dropdown' };
fontDd.click();
await sleepLocal(320);
const maru = q('button[data-name="font-family"][data-value="nanummaruburi"]');
if (!maru) return { applied: false, reason: 'no_maruburi' };
maru.click();
await sleepLocal(320);
const sizeDd = q('button[data-name="font-size"]');
if (!sizeDd) return { applied: false, reason: 'no_size_dropdown' };
sizeDd.click();
await sleepLocal(320);
const fs19 = q('button[data-name="font-size"][data-value="fs19"]');
if (!fs19) return { applied: false, reason: 'no_fs19' };
fs19.click();
await sleepLocal(320);
const alignDd = q('button[data-name="align-drop-down-with-justify"]');
if (!alignDd) return { applied: false, reason: 'no_align_dropdown' };
alignDd.click();
await sleepLocal(320);
const left = q('button[data-name="align-drop-down-with-justify"][data-value="left"]');
if (!left) return { applied: false, reason: 'no_left' };
left.click();
await sleepLocal(320);
const listDd = q('button[data-name="list"]');
if (!listDd) return { applied: false, reason: 'no_list_dropdown' };
listDd.click();
await sleepLocal(320);
const listReset = q('button[data-name="list"][data-value="reset"]');
if (!listReset) return { applied: false, reason: 'no_list_reset' };
listReset.click();
return { applied: true };
}

// In-page: open the font-size dropdown and pick a size (e.g. 'fs24', 'fs19').
async function naverSetFontSizeMain(value) {
const sleepLocal = (ms) => new Promise((r) => setTimeout(r, ms));
const openBtn =
document.querySelector('button[data-name="font-size"][data-type="label-select"]') ||
document.querySelector('button[data-name="font-size"]');
if (!openBtn) return { ok: false, reason: 'no_font_size_button' };
openBtn.click();
await sleepLocal(320);
const opt = document.querySelector(
`button[data-name="font-size"][data-value="${value}"]`,
);
if (!opt) {
openBtn.click();
return { ok: false, reason: `no_option_${value}` };
}
opt.click();
await sleepLocal(150);
return { ok: true, value };
}

// Convert ONE heading line into a 인용구(quotation) block. Uses a REAL CDP
// triple-click (selects the whole paragraph + reliably pops SmartEditor's
// contextual toolbar every time — synthetic DOM events only worked for the
// first heading), then clicks "인용구로 변경" (data-name="to-quotation"),
// verifies the quote actually appeared, and retries.
async function convertHeadingToQuotation(page, editorFrame, cdp, htext, logger) {
const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
const want = norm(htext);
if (!want) return { ok: false, reason: 'empty_target' };

const quoteExists = (target) =>
editorFrame.evaluate((t) => {
const n = (s) => (s || '').replace(/\s+/g, ' ').trim();
const w = n(t);
return Array.from(document.querySelectorAll('.se-section-quotation .se-quote')).some(
(q) => n(q.textContent) === w,
);
}, target);

// Locate the not-yet-quoted paragraph node matching the heading text.
let handle;
try {
handle = await editorFrame.evaluateHandle((t) => {
const n = (s) => (s || '').replace(/\s+/g, ' ').trim();
const w = n(t);
// Search the WHOLE document: inserting a quotation SPLITS the body into
// multiple .se-component.se-text blocks, so a single-component scope would
// miss headings that ended up in a later component.
for (const p of document.querySelectorAll('p.se-text-paragraph')) {
if (p.closest('.se-section-quotation')) continue; // skip quote + cite lines
if (p.closest('.se-documentTitle')) continue; // skip the post title
const pt = n(p.textContent);
if (pt === w) return p;
}
return null;
}, htext);
} catch (e) {
return { ok: false, reason: `handle_err:${(e.message || String(e)).slice(0, 40)}` };
}

const el = handle && handle.asElement ? handle.asElement() : null;
if (!el) {
try {
await handle?.dispose?.();
} catch {
/* ignore */
}
// None left to convert → maybe already a quotation (duplicate heading text).
return (await quoteExists(htext)) ? { ok: true, already: true } : { ok: false, reason: 'not_found' };
}

try {
await el.scrollIntoViewIfNeeded().catch(() => {});

let sawBtn = false;
let noBox = 0;
for (let attempt = 0; attempt < 6; attempt += 1) {
// Recompute the box each attempt — a previous conversion reflows the page.
await el.scrollIntoViewIfNeeded().catch(() => {});
const box = await el.boundingBox();
if (!box) {
noBox += 1;
await sleep(180);
continue;
}
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;

// 1) Single click FIRST to clear any block-selected state left by the
//    previous conversion (a selected quotation hides the text toolbar).
await cdp.send('Input.dispatchMouseEvent', {
type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1, buttons: 1,
});
await cdp.send('Input.dispatchMouseEvent', {
type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1, buttons: 0,
});
await sleep(150);
// 2) Triple-click to select the whole paragraph → contextual toolbar appears.
for (let c = 1; c <= 3; c += 1) {
await cdp.send('Input.dispatchMouseEvent', {
type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: c, buttons: 1,
});
await cdp.send('Input.dispatchMouseEvent', {
type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: c, buttons: 0,
});
await sleep(60);
}
await sleep(260);

const r = await editorFrame.evaluate(() => {
const btn =
document.querySelector('button[data-name="to-quotation"]') ||
document.querySelector('.se-to-quotation-toolbar-button');
if (!btn) return { sawBtn: false };
btn.click();
return { sawBtn: true };
});
if (r.sawBtn) sawBtn = true;
await sleep(300);
if (await quoteExists(htext)) return { ok: true, attempts: attempt + 1 };
logger?.info?.(
`[NAVER][DEBUG] heading convert retry ${attempt + 1} sawBtn=${r.sawBtn}`,
);
await sleep(160);
}
return { ok: false, reason: noBox >= 6 ? 'no_box' : sawBtn ? 'clicked_no_convert' : 'no_button' };
} finally {
try {
await handle?.dispose?.();
} catch {
/* ignore */
}
}
}

// In-page: find the paragraph matching `paraText`, locate the `hlText`
// substring inside it, and return the pixel rects (iframe-relative) of the
// substring's start/end so a real CDP drag can select exactly that text.
function naverLocateHighlightRectsMain(arg) {
  const norm = (s) => (s || '').replace(/[\u200B\u200b\ufeff\u00a0]/g, '').replace(/\s+/g, ' ').trim();
  const wantPara = norm(arg && arg.paraText);
  const wantHl = norm(arg && arg.hlText);
  if (!wantHl) return { ok: false, reason: 'empty_hl' };

  let para = null;
  const paragraphs = Array.from(document.querySelectorAll('p.se-text-paragraph'))
    .filter(p => !p.closest('.se-documentTitle'));

  // 1차 시도: 본문 문단과 전체 텍스트가 정확히 일치하는지 확인
  for (const p of paragraphs) {
    if (norm(p.textContent) === wantPara) {
      para = p;
      break;
    }
  }

  // 2차 시도 (대비책): 정확히 일치하지 않는 경우, 하이라이트할 텍스트를 포함하고 있는 문단 찾기
  if (!para) {
    for (const p of paragraphs) {
      if (norm(p.textContent).includes(wantHl)) {
        para = p;
        break;
      }
    }
  }

  if (!para) return { ok: false, reason: 'para_not_found' };

// Concatenate the paragraph's text nodes; locate the highlight in the raw text.
const walker = document.createTreeWalker(para, NodeFilter.SHOW_TEXT, null);
const nodes = [];
let full = '';
let tn;
while ((tn = walker.nextNode())) {
nodes.push({ node: tn, start: full.length, len: (tn.nodeValue || '').length });
full += tn.nodeValue || '';
}
if (!nodes.length) return { ok: false, reason: 'no_text_nodes' };

let rawStart = full.indexOf(wantHl);
let rawEnd;
if (rawStart >= 0) {
rawEnd = rawStart + wantHl.length;
} else {
// Whitespace-tolerant fallback: search the collapsed text, map back to raw.
const fullC = full.replace(/\s+/g, ' ');
const ci = fullC.indexOf(wantHl);
if (ci < 0) return { ok: false, reason: 'hl_not_in_text' };
const mapCollapsedToRaw = (collapsedIdx) => {
let cc = 0;
let prev = false;
for (let i = 0; i < full.length; i += 1) {
if (cc === collapsedIdx) return i;
if (/\s/.test(full[i])) {
if (!prev) cc += 1;
prev = true;
} else {
cc += 1;
prev = false;
}
}
return full.length;
};
rawStart = mapCollapsedToRaw(ci);
rawEnd = mapCollapsedToRaw(ci + wantHl.length);
}

const locate = (g) => {
for (const n of nodes) {
if (g >= n.start && g <= n.start + n.len) return { node: n.node, offset: g - n.start };
}
const last = nodes[nodes.length - 1];
return { node: last.node, offset: last.len };
};
const s = locate(rawStart);
const e = locate(rawEnd);
let rects;
try {
const range = document.createRange();
range.setStart(s.node, s.offset);
range.setEnd(e.node, e.offset);
try {
para.scrollIntoView({ block: 'center' });
} catch {
/* ignore */
}
rects = range.getClientRects();
} catch {
return { ok: false, reason: 'range_err' };
}
if (!rects || !rects.length) return { ok: false, reason: 'no_rects' };
const first = rects[0];
const last = rects[rects.length - 1];
return {
ok: true,
start: { x: first.left + 1, y: first.top + first.height / 2 },
end: { x: last.right - 1, y: last.top + last.height / 2 },
};
}

// In-page (async): open the 글자 배경색(background-color) toolbar button and
// pick the #fff8b2 swatch for the current selection.
async function naverApplyHighlightColorMain() {
const sleepL = (ms) => new Promise((r) => setTimeout(r, ms));
const btn =
document.querySelector('button[data-name="background-color"]') ||
document.querySelector('.se-background-color-toolbar-button');
if (!btn) return { ok: false, reason: 'no_bg_button' };
btn.click();
await sleepL(240);
const sw =
document.querySelector('button.se-color-palette[data-color="#fff8b2"]') ||
document.querySelector('button[data-color="#fff8b2"]');
if (!sw) return { ok: false, reason: 'no_swatch' };
sw.click();
return { ok: true };
}

// In-page: verify a #fff8b2 background was applied to text containing `hlText`.
function naverHighlightAppliedMain(arg) {
const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
const want = norm(arg && arg.hlText);
if (!want) return { ok: false };
for (const el of document.querySelectorAll('p.se-text-paragraph [style*="background"]')) {
const bg = ((el.style && el.style.backgroundColor) || '').replace(/\s+/g, '').toLowerCase();
if (bg === 'rgb(255,248,178)' || bg === '#fff8b2') {
const t = norm(el.textContent);
if (t && (t.includes(want) || want.includes(t))) return { ok: true };
}
}
return { ok: false };
}

// Apply a background-color highlight to one `hlText` substring within the
// paragraph whose text is `paraText`: drag-select the substring with a REAL CDP
// mouse (pops the property toolbar), click 배경색 → #fff8b2, verify, retry.
async function applyHighlight(page, editorFrame, cdp, paraText, hlText, logger) {
let fbox;
try {
const frameEl = await editorFrame.frameElement();
fbox = await frameEl.boundingBox();
} catch {
fbox = null;
}
if (!fbox) return { ok: false, reason: 'no_frame_box' };

let lastReason = 'unknown';
for (let attempt = 0; attempt < 4; attempt += 1) {
const r = await editorFrame.evaluate(naverLocateHighlightRectsMain, { paraText, hlText });
if (!r || !r.ok) {
lastReason = r?.reason || 'locate_failed';
// Text-based failures won't fix themselves by retrying — bail early.
if (['para_not_found', 'hl_not_in_text', 'empty_hl', 'no_text_nodes'].includes(lastReason)) {
return { ok: false, reason: lastReason };
}
await sleep(150);
continue;
}
const sx = fbox.x + r.start.x;
const sy = fbox.y + r.start.y;
const ex = fbox.x + r.end.x;
const ey = fbox.y + r.end.y;

// Real CDP drag selects the substring (synthetic events don't pop the toolbar).
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sx, y: sy });
await cdp.send('Input.dispatchMouseEvent', {
type: 'mousePressed', x: sx, y: sy, button: 'left', clickCount: 1, buttons: 1,
});
const steps = 6;
for (let st = 1; st <= steps; st += 1) {
const ix = sx + ((ex - sx) * st) / steps;
const iy = sy + ((ey - sy) * st) / steps;
await cdp.send('Input.dispatchMouseEvent', {
type: 'mouseMoved', x: ix, y: iy, button: 'left', buttons: 1,
});
await sleep(20);
}
await cdp.send('Input.dispatchMouseEvent', {
type: 'mouseReleased', x: ex, y: ey, button: 'left', clickCount: 1, buttons: 0,
});
await sleep(240);

const ap = await editorFrame.evaluate(naverApplyHighlightColorMain);
await sleep(300);
if (ap?.ok) {
const v = await editorFrame.evaluate(naverHighlightAppliedMain, { hlText });
if (v?.ok) return { ok: true, attempts: attempt + 1 };
lastReason = 'applied_no_verify';
} else {
lastReason = ap?.reason || 'apply_failed';
}
logger?.info?.(`[NAVER][DEBUG] highlight retry ${attempt + 1} reason=${lastReason}`);
await sleep(150);
}
return { ok: false, reason: lastReason };
}

async function setNaverFontSize(page, editorFrame, value, logger) {
const frames = [editorFrame, page.mainFrame()];
for (let idx = 0; idx < frames.length; idx += 1) {
try {
const r = await frames[idx].evaluate(naverSetFontSizeMain, value);
if (r?.ok) {
logger?.info?.(`[NAVER][DEBUG] font-size ${value} APPLIED (frame${idx})`);
return true;
}
logger?.info?.(
`[NAVER][DEBUG] font-size ${value} frame${idx} not applied reason=${r?.reason || '?'}`,
);
} catch (e) {
logger?.info?.(
`[NAVER][DEBUG] font-size ${value} frame${idx} error=${(e.message || String(e)).slice(0, 80)}`,
);
}
}
return false;
}

async function pressEnterCdp(cdp) {
await cdp.send('Input.dispatchKeyEvent', {
type: 'keyDown',
windowsVirtualKeyCode: 13,
code: 'Enter',
key: 'Enter',
nativeVirtualKeyCode: 13,
});
await cdp.send('Input.dispatchKeyEvent', {
type: 'keyUp',
windowsVirtualKeyCode: 13,
code: 'Enter',
key: 'Enter',
nativeVirtualKeyCode: 13,
});
}

function naverStickerToolbarClickOpenMain() {
const btn =
document.querySelector('button[data-name="sticker"]') ||
document.querySelector('button.se-sticker-toolbar-button');
if (!btn) return { ok: false };
btn.click();
return { ok: true };
}

function naverStickerSidebarPickRandomClickMain() {
const list =
document.querySelector('ul.se-sidebar-list.se-is-on') ||
document.querySelector('ul.se-sidebar-list');
if (!list) return { ok: false };
const buttons = list.querySelectorAll('button.se-sidebar-element-sticker');
if (!buttons.length) return { ok: false };
buttons[Math.floor(Math.random() * buttons.length)].click();
return { ok: true };
}

async function resolveEditorFrame(page, logger) {
const deadline = Date.now() + EDITOR_READY_TIMEOUT_MS;
while (Date.now() < deadline) {
let bestFrame = null;
let bestScore = 0;
for (const frame of page.frames()) {
try {
const probe = await frame.evaluate(naverEditorProbeFrameMain);
if (probe?.score > bestScore) {
bestScore = probe.score;
bestFrame = frame;
}
} catch {
/* ignore */
}
}
if (bestFrame && bestScore >= 200) {
logger?.info?.(`[NAVER] editor frame score=${bestScore}`);
return bestFrame;
}
await sleep(EDITOR_POLL_MS);
}
return null;
}

function* naverCdpUnicodeChunks(str, maxChars) {
let buf = '';
let n = 0;
for (const ch of str) {
buf += ch;
n += 1;
if (n >= maxChars) {
yield buf;
buf = '';
n = 0;
}
}
if (buf.length) yield buf;
}

async function insertCdpCharEventsOnly(cdp, text, delayMsPerChar) {
const gap = delayMsPerChar >= 0 ? delayMsPerChar : 0;
const chars = Array.from(text);
for (let i = 0; i < chars.length; i += 1) {
const ch = chars[i];
if (ch === '\r') continue;
if (ch === '\n') {
await cdp.send('Input.dispatchKeyEvent', {
type: 'keyDown',
windowsVirtualKeyCode: 13,
code: 'Enter',
key: 'Enter',
nativeVirtualKeyCode: 13,
});
await cdp.send('Input.dispatchKeyEvent', {
type: 'keyUp',
windowsVirtualKeyCode: 13,
code: 'Enter',
key: 'Enter',
nativeVirtualKeyCode: 13,
});
} else {
await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: ch });
}
if (gap > 0) await sleep(gap);
}
}

async function insertTextOrCharOneSlice(cdp, slice, logger) {
if (!slice.length) return;
try {
await cdp.send('Input.insertText', { text: slice });
return;
} catch (e) {
logger?.info?.(`[NAVER] insertText fallback: ${e.message || e}`);
}
await insertCdpCharEventsOnly(cdp, slice, 0);
}

async function insertTextOrCharFallback(cdp, text, opts, logger) {
const maxChunk = opts?.maxChunk > 8 ? opts.maxChunk : 48;
const gapMs = opts?.interChunkMs >= 0 ? opts.interChunkMs : 12;
if (text.length <= maxChunk) {
await insertTextOrCharOneSlice(cdp, text, logger);
return;
}
for (const piece of naverCdpUnicodeChunks(text, maxChunk)) {
await insertTextOrCharOneSlice(cdp, piece, logger);
await sleep(gapMs);
}
}

async function uploadNaverImage(page, editorFrame, imagePath, logger) {
const fs = require('fs');
if (!imagePath || !fs.existsSync(imagePath)) {
return false;
}

logger?.info?.('[NAVER] clicking photo button...');
try {
const photoBtn = editorFrame.locator('button.se-image-toolbar-button, button[data-name="image"]').first();
const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 10000 }).catch(() => null);
await photoBtn.click();
const fileChooser = await fileChooserPromise;
if (fileChooser) {
await fileChooser.setFiles(imagePath);
logger?.info?.('[NAVER] file chooser set, waiting for upload...');
await sleep(5000);
return true;
} else {
logger?.info?.('[NAVER] filechooser event not caught');
return false;
}
} catch(e) {
logger?.error?.(`[NAVER] uploadNaverImage error: ${e.message}`);
return false;
}
}



async function tryNaverFillWithCdp(page, editorFrame, titleText, bodyText, logger, blocks, thumbnail, intro, options) {
const title = typeof titleText === 'string' ? titleText : '';
const body = typeof bodyText === 'string' ? bodyText : '';
const blockList = Array.isArray(blocks) ? blocks : null;
if (!title.length && !body.length && !(blockList && blockList.length)) return false;
if (!editorFrame) return false;

let cdp;
try {
cdp = await page.context().newCDPSession(page);
try {
await cdp.send('Input.enable', {});
} catch {
/* ignore */
}

const prep = await editorFrame.evaluate(naverEditorCdpEnsureEditorReadyMain);
if (!prep?.ok) return false;

if (title.length) {
const fr = await editorFrame.evaluate(naverEditorFocusFieldMain, 'title');
logger?.info?.(
`[NAVER][DEBUG] title focus ok=${fr?.ok} ${JSON.stringify(fr?.debug || fr?.reason || '')}`,
);
if (!fr?.ok) return false;
await sleep(200);
      // Title field needs char events (insertText silently no-ops here).
      // The first keystroke often triggers a framework re-render (React/Vue), which drops the 2nd character.
      // We type the first character, wait for the state to settle, then type the rest.
      if (title.length > 0) {
        await page.keyboard.type(title.charAt(0), { delay: 100 });
        await sleep(600); // Wait for editor state changes
        if (title.length > 1) {
          await page.keyboard.type(title.slice(1), { delay: 100 });
        }
      }
logger?.info?.(`[NAVER][DEBUG] title typed (${title.length} chars)`);
}

if (blockList && blockList.length) {
// Body fill in TWO passes so toolbar clicks never interleave with newline
// insertion (interleaving made SmartEditor trim freshly-created blank lines
// and eat queued Enters around headings/imgplace).
//   PASS 1 — type every block as plain text at fs19 with the right Enters.
//   PASS 2 — convert each heading line into a 인용구(quotation) block.
if (title.length) await sleep(450);
const fr = await editorFrame.evaluate(naverEditorFocusFieldMain, 'body');
logger?.info?.(
`[NAVER][DEBUG] body focus ok=${fr?.ok} ${JSON.stringify(fr?.debug || fr?.reason || '')}`,
);
if (!fr?.ok) return false;
await sleep(320);
await editorFrame.evaluate(naverEditorFocusFieldMain, 'body');
await sleep(220);

// Upload image if provided (at top of body)
if (options && options.imagePath) {
await uploadNaverImage(page, editorFrame, options.imagePath, logger);
await editorFrame.evaluate(naverEditorFocusFieldMain, 'body');
await sleep(150);
}



// Base size once, then re-focus so all typing lands in the editor.
await setNaverFontSize(page, editorFrame, 'fs19', logger);
await editorFrame.evaluate(naverEditorFocusFieldMain, 'body');
await sleep(150);

// Thumbnail: put a "썸네일 삽입 공간" marker line at the very top (one Enter
// after) BEFORE the body — the image flow replaces it with the thumbnail.
if (thumbnail) {
await insertCdpCharEventsOnly(cdp, '썸네일 삽입 공간', 6);
await sleep(150);
await pressEnterCdp(cdp);
await sleep(130);
logger?.info?.('[NAVER][DEBUG] thumbnail marker "썸네일 삽입 공간" inserted at top');
}

// Greeting (intro): typed first, before the body blocks (paragraph spacing).
const introText = typeof intro === 'string' ? intro.trim() : '';
if (introText.length) {
await insertCdpCharEventsOnly(cdp, introText, 6);
await sleep(150);
await pressEnterCdp(cdp);
await sleep(120);
await pressEnterCdp(cdp);
await sleep(120);

logger?.info?.(`[NAVER][DEBUG] intro greeting typed (${introText.length} chars) + Enter x2`);
}

for (let i = 0; i < blockList.length; i += 1) {
const block = blockList[i] || {};
const text = typeof block.text === 'string' ? block.text : '';
const isLast = i === blockList.length - 1;
logger?.info?.(
  `[NAVER][DEBUG] block ${i + 1}/${blockList.length} type=${block.type} last=${isLast} chars=${text.length} text="${text.slice(0, 24)}"`,
);

// imgplace: one Enter BEFORE the marker (blank line above the image slot).
if (block.type === 'imgplace') {
  await pressEnterCdp(cdp);
  await sleep(110);
  logger?.info?.(`[NAVER][DEBUG] block ${i + 1} imgplace: Enter before`);
}
// imgplace block.text is already a SHORT marker like '이미지 삽입공간 : ...'
// (converted by naver_common.js). It MUST be typed into the editor so that
// naver_image.js can locate the position and paste the generated image there.
if (text.length) {
  await insertCdpCharEventsOnly(cdp, text, 6);
  await sleep(140);
  logger?.info?.(`[NAVER][DEBUG] block ${i + 1} typed`);
}
// Enter count AFTER the block (no font click follows in this pass, so the
// blank lines survive — no editor auto-trim):
//  - paragraph → 2 (spacing between paragraphs / before next block)
//  - summary   → 2 (extra spacing after the summary block)
//  - imgplace  → 1 (Enter after the marker)
//  - others    → 1 if not last
let enterCount = 0;
if (block.type === 'paragraph') {
  enterCount = 2;
} else if (block.type === 'summary') {
  enterCount = 2;
} else if (block.type === 'imgplace') {
  enterCount = 1;
} else if (!isLast) {
  enterCount = 1;
}
for (let e = 0; e < enterCount; e += 1) {
await pressEnterCdp(cdp);
await sleep(120);
}
if (enterCount) {
logger?.info?.(`[NAVER][DEBUG] block ${i + 1} type=${block.type} Enter x${enterCount}`);
}
}
logger?.info?.('[NAVER][DEBUG] PASS1 done — all blocks typed');

// Wait for the editor to fully settle after all PASS1 text insertion before
// starting heading conversions (imgplace markers + Enter keys can trigger reflows).
await sleep(400);

// PASS 2 — convert each heading line into a 인용구(quotation) block by
// selecting that line and clicking "인용구로 변경" (to-quotation). The
// content below already exists, so there's no "escape the quote" problem.
const headings = blockList.filter((b) => b && b.type === 'heading');
logger?.info?.(`[NAVER][DEBUG] body fill PASS2: ${headings.length} heading(s) → quotation`);
for (let h = 0; h < headings.length; h += 1) {
const htext = typeof headings[h].text === 'string' ? headings[h].text : '';
if (!htext.trim()) continue;
let r = null;
try {
  r = await convertHeadingToQuotation(page, editorFrame, cdp, htext, logger);
} catch (e) {
  logger?.info?.(
    `[NAVER][DEBUG] heading ${h + 1} convert error=${(e.message || String(e)).slice(0, 80)}`,
  );
}
if (r?.ok) {
  logger?.info?.(
    `[NAVER][DEBUG] heading ${h + 1} → quotation OK "${htext.slice(0, 20)}"${r.already ? ' (already)' : ''} attempts=${r.attempts || '-'}`,
  );
} else {
  logger?.info?.(
    `[NAVER][DEBUG] heading ${h + 1} → quotation FAIL "${htext.slice(0, 20)}" reason=${r?.reason || '?'}`,
  );
}
// Increased: quotation insertion causes DOM reflow (body splits into multiple
// se-component blocks). Without sufficient wait, the next heading's bounding-
// box lookup can land on the wrong element and convert the wrong paragraph.
await sleep(500);
}
logger?.info?.('[NAVER][DEBUG] PASS2 done — headings converted to quotation');

// PASS 3 — apply a background-color highlight (#fff8b2) to each block's
// "highlights" substrings by drag-selecting them like the quotation flow.
const hlBlocks = blockList.filter(
(b) => b && Array.isArray(b.highlights) && b.highlights.length,
);
const hlTotal = hlBlocks.reduce((acc, b) => acc + b.highlights.length, 0);
logger?.info?.(
`[NAVER][DEBUG] body fill PASS3: ${hlTotal} highlight(s) across ${hlBlocks.length} block(s)`,
);
let hlIndex = 0;
for (const b of hlBlocks) {
for (const hl of b.highlights) {
hlIndex += 1;
let hr = null;
try {
hr = await applyHighlight(page, editorFrame, cdp, b.text, hl, logger);
} catch (e) {
logger?.info?.(
`[NAVER][DEBUG] highlight ${hlIndex} error=${(e.message || String(e)).slice(0, 80)}`,
);
}
if (hr?.ok) {
logger?.info?.(
`[NAVER][DEBUG] highlight ${hlIndex} → OK "${hl.slice(0, 24)}" attempts=${hr.attempts || '-'}`,
);
} else {
logger?.info?.(
`[NAVER][DEBUG] highlight ${hlIndex} → FAIL "${hl.slice(0, 24)}" reason=${hr?.reason || '?'}`,
);
}
await sleep(160);
}
}
logger?.info?.('[NAVER][DEBUG] PASS3 done — highlights applied');
} else if (body.length) {
if (title.length) await sleep(450);
const fr = await editorFrame.evaluate(naverEditorFocusFieldMain, 'body');
if (!fr?.ok) return false;
await sleep(320);
await editorFrame.evaluate(naverEditorFocusFieldMain, 'body');
await sleep(220);

// Upload image if provided
if (options && options.imagePath) {
await uploadNaverImage(page, editorFrame, options.imagePath, logger);
await editorFrame.evaluate(naverEditorFocusFieldMain, 'body');
await sleep(150);
}

await insertCdpCharEventsOnly(cdp, body, 6);
}

logger?.info?.('[NAVER] CDP fill done');
return true;
} catch (e) {
logger?.info?.(`[NAVER] CDP fill error: ${e.message || e}`);
return false;
} finally {
if (cdp) await cdp.detach().catch(() => {});
}
}

async function evaluateInAnyFrame(page, fn) {
for (const frame of page.frames()) {
try {
const result = await frame.evaluate(fn);
if (result?.ok || result?.clicked || result?.applied) return result;
} catch {
/* ignore */
}
}
return null;
}

async function naverApplyRandomSticker(page, logger) {
if (!(await evaluateInAnyFrame(page, naverStickerToolbarClickOpenMain))?.ok) {
logger?.info?.('[NAVER] sticker open failed');
return false;
}
await sleep(420);
for (let i = 0; i < 14; i += 1) {
if ((await evaluateInAnyFrame(page, naverStickerSidebarPickRandomClickMain))?.ok) {
logger?.info?.('[NAVER] sticker attached');
return true;
}
await sleep(200);
}
return false;
}

async function naverApplyBodyToolbarFormatting(page, editorFrame, logger) {
const focus = await editorFrame.evaluate(naverEditorFocusFieldMain, 'body');
if (!focus?.ok) return false;
if (!(await editorFrame.evaluate(naverEditorOpenBodyContextMenuMain))?.ok) return false;
await sleep(220);
if (!(await evaluateInAnyFrame(page, naverEditorClickContextMenuSelectAllMain))?.clicked) {
return false;
}
await sleep(200);
for (const frame of [editorFrame, page.mainFrame()]) {
try {
if ((await frame.evaluate(naverToolbarFormattingSequenceMain))?.applied) {
logger?.info?.('[NAVER] format applied');
return true;
}
} catch {
/* ignore */
}
}
return false;
}

async function tryClickSelectorsInAllFrames(page, selectors) {
for (const frame of page.frames()) {
try {
const result = await frame.evaluate((list) => {
for (const sel of list) {
let el = null;
if (sel.startsWith('TEXT=')) {
const text = sel.slice(5);
el = Array.from(document.querySelectorAll('label, button, input')).find(e => e.textContent.includes(text));
} else {
try { el = document.querySelector(sel); } catch(e) {}
}
if (el) {
el.click();
return { ok: true, sel };
}
}
return { ok: false };
}, selectors);
if (result?.ok) return result;
} catch {
/* ignore */
}
}
return { ok: false };
}

async function tryCheckSelectorsInAllFrames(page, selectors) {
for (const frame of page.frames()) {
try {
const result = await frame.evaluate((list) => {
for (const sel of list) {
let el = null;
if (sel.startsWith('TEXT=')) {
const text = sel.slice(5);
el = Array.from(document.querySelectorAll('label, button, input')).find(e => e.textContent.includes(text));
} else {
try { el = document.querySelector(sel); } catch(e) {}
}
if (el) {
if (el.tagName.toLowerCase() === 'input' && el.type === 'checkbox') {
if (!el.checked) el.click();
} else if (el.tagName.toLowerCase() === 'input' && el.type === 'radio') {
if (!el.checked) el.click();
} else if (el.tagName.toLowerCase() === 'label') {
const forId = el.getAttribute('for');
const input = forId ? document.getElementById(forId) : null;
if (input && !input.checked) el.click();
else if (!input) el.click(); // fallback
} else {
el.click();
}
return { ok: true, sel };
}
}
return { ok: false };
}, selectors);
if (result?.ok) return result;
} catch {
/* ignore */
}
}
return { ok: false };
}


async function pollUntilPublishClick(page, selectors, timeoutMs, stepMs, logLabel, logger) {
const t0 = Date.now();
while (Date.now() - t0 < timeoutMs) {
const r = await tryClickSelectorsInAllFrames(page, selectors);
if (r?.ok) {
logger?.info?.(`[NAVER] publish ${logLabel} ok`);
return true;
}
await sleep(stepMs);
}
logger?.info?.(`[NAVER] publish ${logLabel} timeout`);
return false;
}

async function naverPublishPostPublic(page, options = {}) {

const logger = options.logger || null;
const pSel = NAVER_PUBLISH_SELECTORS;

const visibility = options.visibility || '2';
// dynamically change the public selector depending on visibility
const openSelector = pSel.openPublic.map(sel => {
if (sel.includes('value="2"')) return sel.replace('value="2"', `value="${visibility}"`);
if (sel.includes('#open_public')) return sel.replace('public', visibility === '0' ? 'private' : (visibility === '1' ? 'neighbor' : (visibility === '3' ? 'both_neighbor' : 'public')));
if (sel.startsWith('TEXT=')) {
const texts = { '0': '비공개', '1': '이웃공개', '2': '전체공개', '3': '서로이웃공개' };
return `TEXT=${texts[visibility] || '전체공개'}`;
}
return sel;
});

const openLayerOk = await pollUntilPublishClick(
page,
pSel.openLayer,
22000,
400,
'open_layer',
logger,
);
if (!openLayerOk) return { ok: false, detail: 'openLayer timeout' };

await sleep(500);

const publicOk = await pollUntilPublishClick(
page,
openSelector,
28000,
450,
'public',
logger,
);
if (!publicOk) return { ok: false, detail: 'public options timeout' };

await sleep(500);

// Enable all settings
await tryCheckSelectorsInAllFrames(page, NAVER_PUBLISH_SELECTORS.allowComments);
await sleep(100);
await tryCheckSelectorsInAllFrames(page, NAVER_PUBLISH_SELECTORS.allowSympathy);
await sleep(100);
await tryCheckSelectorsInAllFrames(page, NAVER_PUBLISH_SELECTORS.allowSearch);
await sleep(100);
await tryCheckSelectorsInAllFrames(page, NAVER_PUBLISH_SELECTORS.allowScrap);
await sleep(100);
await tryCheckSelectorsInAllFrames(page, NAVER_PUBLISH_SELECTORS.allowExternal);
await sleep(400);

const confirmOk = await pollUntilPublishClick(
page,
NAVER_PUBLISH_SELECTORS.confirm,
35000,
500,
'confirm',
logger,
);

return { ok: confirmOk, detail: confirmOk ? '' : 'confirm timeout' };
}

async function pasteNaverTitleAndBody(page, titleText, bodyText, logger, options = {}) {
// applyExtras=false → only fill title+body (skip sticker + toolbar formatting).
const applyExtras = options.applyExtras !== false;
const blocks = Array.isArray(options.blocks) ? options.blocks : null;
const thumbnail = options.thumbnail === true;
const intro = typeof options.intro === 'string' ? options.intro.trim() : '';
const gapsMs = [500, 1000, 1800, 3000, 5000, 8000, 12000];
const title = typeof titleText === 'string' ? titleText.trim() : '';
const body = typeof bodyText === 'string' ? bodyText : '';
if (!title.length && !body.length && !(blocks && blocks.length)) return false;

for (let attempt = 0; attempt < gapsMs.length; attempt += 1) {
await sleep(gapsMs[attempt]);
const editorFrame = await resolveEditorFrame(page, logger);
if (!editorFrame) continue;

if (await tryNaverFillWithCdp(page, editorFrame, title, body, logger, blocks, thumbnail, intro, options)) {
if (applyExtras && body.length) {
await sleep(400);
// await naverApplyRandomSticker(page, logger);
await sleep(350);
await naverApplyBodyToolbarFormatting(page, editorFrame, logger);
        await sleep(200);
        try {
          const cleanR = await editorFrame.evaluate(naverCleanupEmptyQuotationsMain);
          if (cleanR && cleanR.removed > 0) {
            logger?.info?.(`[NAVER] cleaned up ${cleanR.removed} empty quotation(s)`);
          }
        } catch (e) {
          /* ignore */
        }
      }
return true;
}
}
return false;
}

// Find the first frame (across all frames) whose document has `selector`.
async function findFrameWithSelector(page, selector) {
for (const frame of page.frames()) {
try {
if (await frame.evaluate((s) => !!document.querySelector(s), selector)) {
return frame;
}
} catch {
/* ignore */
}
}
return null;
}

// In-page: within the open category dropdown, click the list item matching
// `want` (the category element id like "1_게시판", or its label text, or the
// numeric prefix). Returns what it clicked / what was available.
function naverPickCategoryInListMain(w) {
const n = (s) => (s || '').replace(/\s+/g, ' ').trim();
const want = n(w);
const list = document.querySelector('ul.list__RcvVA');
if (!list) return { ok: false, reason: 'no_list' };
const items = list.querySelectorAll('li.item__sAGX9');
const available = [];
for (const li of items) {
const input = li.querySelector('input.radio_item__PIBr7, input[type="radio"]');
const label = li.querySelector('label');
const text = n(label ? label.textContent : li.textContent);
const id = input ? input.id : '';
const numId = id.indexOf('_') >= 0 ? id.slice(0, id.indexOf('_')) : '';
available.push(id || text);
if (
id === want ||
text === want ||
(numId && numId === want) ||
(id && id.endsWith(`_${want}`)) ||
(text && text.includes(want))
) {
(label || input).click();
return { ok: true, id, text };
}
}
return { ok: false, reason: 'no_match', available };
}

// Open the category dropdown (카테고리 목록 버튼) and select the category that
// matches `target` (the element id / label / numeric prefix).
async function naverSelectCategory(page, target, logger) {
const want = String(target || '').trim();
if (!want) {
logger?.info?.('[NAVER][PUB] no category specified — leaving default');
return { ok: true, skipped: true };
}
logger?.info?.(`[NAVER][PUB] selecting category "${want}"...`);
const catBtnSelectors = [
'button[data-click-area="tpb*i.category"]',
'button[aria-label="카테고리 목록 버튼"]',
'button.selectbox_button__jb1Dt',
];
let opened = false;
for (let i = 0; i < 15 && !opened; i += 1) {
const r = await tryClickSelectorsInAllFrames(page, catBtnSelectors);
if (r?.ok) {
opened = true;
logger?.info?.(`[NAVER][PUB] category button clicked (${r.sel})`);
} else {
await sleep(350);
}
}
if (!opened) {
logger?.info?.('[NAVER][PUB] category button NOT found');
return { ok: false, reason: 'no_category_button' };
}
await sleep(400);

for (let i = 0; i < 15; i += 1) {
for (const frame of page.frames()) {
try {
const r = await frame.evaluate(naverPickCategoryInListMain, want);
if (r?.ok) {
logger?.info?.(`[NAVER][PUB] category selected id="${r.id}" text="${r.text}"`);
await sleep(300);
return { ok: true };
}
if (r && r.reason === 'no_match') {
logger?.info?.(
`[NAVER][PUB] category no match yet (available: ${JSON.stringify(r.available)})`,
);
}
} catch {
/* ignore */
}
}
await sleep(350);
}
logger?.info?.(`[NAVER][PUB] category "${want}" NOT selected`);
return { ok: false, reason: 'no_category_match' };
}

// In-page: within the open 주제 theme grid, click the item matching `want`
// (the subject element id like "영화_6", or its label text).
function naverPickSubjectInListMain(w) {
const n = (s) => (s || '').replace(/\s+/g, ' ').trim();
const want = n(w);
const wrap =
document.querySelector('div.theme_list_wrap__IpKh9') ||
document.querySelector('.theme_list_wrap__IpKh9');
if (!wrap) return { ok: false, reason: 'no_grid' };
const items = wrap.querySelectorAll('li.item__sAGX9');
const available = [];
for (const li of items) {
const input =
li.querySelector('input[data-click-area="tpb*i.subjectlist"]') ||
li.querySelector('input[type="radio"]');
const label = li.querySelector('label');
const text = n(label ? label.textContent : li.textContent);
const id = input ? input.id : '';
available.push(id || text);
if (id === want || text === want) {
(label || input).click();
return { ok: true, id, text };
}
}
return { ok: false, reason: 'no_match', available };
}

// Open the 주제(subject) dropdown and select the theme matching `target`.
async function naverSelectSubject(page, target, logger) {
const want = String(target || '').trim();
if (!want) {
logger?.info?.('[NAVER][PUB] no subject specified — leaving default');
return { ok: true, skipped: true };
}
logger?.info?.(`[NAVER][PUB] selecting subject "${want}"...`);
const btnSelectors = [
'a[data-click-area="tpb*i.subject"]',
'a[aria-label="주제 목록 버튼"]',
'a.link__g9ed3',
];
let opened = false;
for (let i = 0; i < 15 && !opened; i += 1) {
const r = await tryClickSelectorsInAllFrames(page, btnSelectors);
if (r?.ok) {
opened = true;
logger?.info?.(`[NAVER][PUB] subject button clicked (${r.sel})`);
} else {
await sleep(350);
}
}
if (!opened) {
logger?.info?.('[NAVER][PUB] subject button NOT found');
return { ok: false, reason: 'no_subject_button' };
}
await sleep(400);

for (let i = 0; i < 15; i += 1) {
for (const frame of page.frames()) {
try {
const r = await frame.evaluate(naverPickSubjectInListMain, want);
if (r?.ok) {
logger?.info?.(`[NAVER][PUB] subject selected id="${r.id}" text="${r.text}"`);
await sleep(300);
// Confirm the subject selection (확인).
const okSelectors = [
'button[data-click-area="tpb*i.subjectok"]',
'button.ok_btn__mVM4b',
];
let confirmed = false;
for (let k = 0; k < 8 && !confirmed; k += 1) {
const cr = await tryClickSelectorsInAllFrames(page, okSelectors);
if (cr?.ok) {
confirmed = true;
logger?.info?.(`[NAVER][PUB] subject 확인 clicked (${cr.sel})`);
} else {
await sleep(250);
}
}
if (!confirmed) {
logger?.info?.('[NAVER][PUB] subject 확인 button NOT found');
}
await sleep(300);
return { ok: true };
}
if (r && r.reason === 'no_match') {
logger?.info?.(
`[NAVER][PUB] subject no match yet (available: ${JSON.stringify(r.available)})`,
);
}
} catch {
/* ignore */
}
}
await sleep(350);
}
logger?.info?.(`[NAVER][PUB] subject "${want}" NOT selected`);
return { ok: false, reason: 'no_subject_match' };
}

// Click 발행 to open the publish panel, select the category + 주제, then type
// each tag (type → Enter, repeated). Does NOT do the final publish confirm.
async function naverOpenPublishAndEnterTags(page, options, logger) {
const opts = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
const tags = Array.isArray(options) ? options : opts.tags;
const categoryElementId = opts.categoryElementId || '';
const subjectElementId = opts.subjectElementId || '';
const finalPublish = opts.finalPublish === true;
const tagList = Array.isArray(tags)
? tags.map((t) => String(t || '').trim()).filter(Boolean).slice(0, 30)
: [];
logger?.info?.(
`[NAVER][PUB] opening publish panel (category="${categoryElementId}" subject="${subjectElementId}" tags=${tagList.length})...`,
);

// 1) Click the 발행 button (poll — the editor UI may settle late).
const publishSelectors = [
'button[data-click-area="tpb.publish"]',
'button.publish_btn__m9KHH',
];
let opened = false;
for (let i = 0; i < 20 && !opened; i += 1) {
const r = await tryClickSelectorsInAllFrames(page, publishSelectors);
if (r?.ok) {
opened = true;
logger?.info?.(`[NAVER][PUB] 발행 button clicked (${r.sel})`);
} else {
await sleep(400);
}
}
if (!opened) {
logger?.info?.('[NAVER][PUB] 발행 button NOT found');
return { ok: false, reason: 'no_publish_button' };
}

// 2) Select the category, then the 블로그 주제 (before tags).
await sleep(500);
await naverSelectCategory(page, categoryElementId, logger);
await sleep(300);
await naverSelectSubject(page, subjectElementId, logger);

// 2.5) Set visibility (공개 설정). Default: 전체공개 (value "2").
const visibility = String(opts.visibility || '2');
const visTexts = { '0': '비공개', '1': '이웃공개', '2': '전체공개', '3': '서로이웃공개' };
const visText = visTexts[visibility] || '전체공개';
const visSelectors = [
`label[for="open_${visibility === '0' ? 'private' : visibility === '1' ? 'neighbor' : visibility === '3' ? 'both_neighbor' : 'public'}"]`,
`input[name="open_type"][value="${visibility}"]`,
`TEXT=${visText}`,
];
await sleep(400);
const visR = await tryClickSelectorsInAllFrames(page, visSelectors);
if (visR?.ok) {
logger?.info?.(`[NAVER][PUB] visibility set to ${visText} (${visR.sel})`);
} else {
logger?.info?.(`[NAVER][PUB] visibility selector not found — leaving default`);
}
await sleep(300);

// 2.6) Enable allowComments, allowSympathy, allowSearch, allowScrap, allowExternal.
await tryCheckSelectorsInAllFrames(page, NAVER_PUBLISH_SELECTORS.allowComments);
await sleep(80);
await tryCheckSelectorsInAllFrames(page, NAVER_PUBLISH_SELECTORS.allowSympathy);
await sleep(80);
await tryCheckSelectorsInAllFrames(page, NAVER_PUBLISH_SELECTORS.allowSearch);
await sleep(80);
await tryCheckSelectorsInAllFrames(page, NAVER_PUBLISH_SELECTORS.allowScrap);
await sleep(80);
await tryCheckSelectorsInAllFrames(page, NAVER_PUBLISH_SELECTORS.allowExternal);
await sleep(200);

// 3) Wait for the tag input to appear in the publish panel.
let frame = null;
for (let i = 0; i < 25 && !frame; i += 1) {
frame = await findFrameWithSelector(page, '#tag-input');
if (!frame) await sleep(400);
}
if (!frame) {
logger?.info?.('[NAVER][PUB] tag input (#tag-input) NOT found');
return { ok: false, reason: 'no_tag_input' };
}
logger?.info?.('[NAVER][PUB] tag input ready');

// 4) Type each tag then Enter (the input clears after each commit).
let entered = 0;
if (!tagList.length) {
logger?.info?.('[NAVER][PUB] no tags to enter');
} else {
const input = frame.locator('#tag-input');
for (const tag of tagList) {
try {
await input.click();
await input.fill('');
await input.pressSequentially(tag, { delay: 25 });
await sleep(120);
await input.press('Enter');
await sleep(200);
entered += 1;
logger?.info?.(`[NAVER][PUB] tag ${entered}/${tagList.length} "${tag}"`);
} catch (e) {
logger?.info?.(
`[NAVER][PUB] tag "${tag}" error=${(e instanceof Error ? e.message : String(e)).slice(0, 80)}`,
);
}
}
logger?.info?.(`[NAVER][PUB] tags entered ${entered}/${tagList.length}`);
}

// 5) Final 발행 (publish confirm) when requested.
let published = false;
if (finalPublish) {
await sleep(400);
logger?.info?.('[NAVER][PUB] clicking final 발행 (publish)...');
const finalSelectors = [
'button[data-click-area="tpb*i.publish"]',
'button[data-testid="seOnePublishBtn"]',
'button.confirm_btn__WEaBq',
];
for (let i = 0; i < 15 && !published; i += 1) {
const r = await tryClickSelectorsInAllFrames(page, finalSelectors);
if (r?.ok) {
published = true;
logger?.info?.(`[NAVER][PUB] final 발행 clicked (${r.sel})`);
} else {
await sleep(350);
}
}
if (!published) {
logger?.info?.('[NAVER][PUB] final 발행 button NOT found');
}
}

return { ok: true, entered, total: tagList.length, published };
}


function naverCleanupEmptyQuotationsMain() {
  let removed = 0;
  const quotes = document.querySelectorAll('blockquote, .se-quote, .se-quote-text, .se-component-quotation, [class*="se-component-quotation"], [class*="se-quotation"]');
  for (const q of quotes) {
    const text = (q.textContent || '').replace(/[\s\u200B\u200b\u00a0]/g, '').trim();
    if (!text) {
      const comp = q.closest('.se-component, .se-section') || q;
      comp.remove();
      removed += 1;
    }
  }
  return { ok: true, removed };
}

module.exports = {
resolveEditorFrame,
tryNaverFillWithCdp,
pasteNaverTitleAndBody,
naverPublishPostPublic,
naverOpenPublishAndEnterTags,
};

