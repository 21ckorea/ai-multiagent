'use strict';

/**
 * @file naver_common.js
 * @description 네이버 블로그 공통 유틸리티 (선택자, URL 판별)
 * @purpose  네이버 블로그 에디터 DOM 선택자, URL 패턴 매칭, 공통 대기 로직 등
 *           네이버 관련 모듈 전반에서 사용하는 공통 헬퍼 모음.
 * @exports  NAVER_SELECTORS, isOnNaverBlogEditor, waitForNaverEditor
 * @seeAlso  naver_editor.js, naver_image.js, playwright_naver_publish.js
 */


const fs = require('fs');
const path = require('path');

const {
  normalizeNaverBlogId,
  buildNaverBlogWriteUrl,
  isNaverLoginFailureUrl,
  isNaverBlogWriteSuccessUrl,
} = require('./playwright_naver_auth');

const FALLBACK_SELECTORS = require('./fallback_selectors.json');

/** Body paste order — bg-naver-flow.js NAVER_GEMINI_BODY_TAG_ORDER */
const NAVER_GEMINI_BODY_TAG_ORDER = [
  'section_1_intro',
  'section_2_info',
  'section_3_deep',
  'section_4_case',
  'section_5_outro',
  'seo_tags',
  'cta_box',
];

const NAVER_GEMINI_BODY_STREAM_TAGS = [...NAVER_GEMINI_BODY_TAG_ORDER, 'img_place'];

const NAVER_PUBLISH_SELECTORS = {
  openLayer: FALLBACK_SELECTORS.naver?.publish?.openBtn || [
    'button[data-click-area="tpb.publish"]',
    'button.publish_btn__m9KHH',
    '.publish_btn__m9KHH',
  ],
  openPrivate: FALLBACK_SELECTORS.naver?.publish?.privateLabel || [
    'label[for="open_private"]',
    '#open_private',
    'input[name="open_type"][value="0"]',
  ],
  openPublic: [
    'label[for="open_public"]',
    '#open_public',
    'input[name="open_type"][value="2"]',
    'TEXT=전체공개'
  ],
  allowComments: [
    'input#publish-option-comment',
    'label[for="publish-option-comment"]',
    'TEXT=댓글허용'
  ],
  allowSympathy: [
    'input#publish-option-sympathy',
    'label[for="publish-option-sympathy"]',
    'TEXT=공감허용'
  ],
  allowSearch: [
    'input#publish-option-search',
    'label[for="publish-option-search"]',
    'TEXT=검색허용'
  ],
  allowScrap: [
    'input#publish-option-scrap',
    'label[for="publish-option-scrap"]',
    'TEXT=블로그/카페 공유'
  ],
  allowExternal: [
    'input#publish-option-outside',
    'label[for="publish-option-outside"]',
    'TEXT=외부 공유 허용'
  ],
  confirm: FALLBACK_SELECTORS.naver?.publish?.confirmBtn || [
    'button[data-testid="seOnePublishBtn"]',
    'button.confirm_btn__WEaBq',
    'button[data-click-area="tpb*i.publish"]',
  ],
};

function escapeRegExpForNaverTag(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeRawForNaverTagParse(raw) {
  let t = String(raw ?? '');
  t = t.replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');

  const knownTags = [
    'final_title', 'content_body', 'img_place',
    'section_1_intro', 'section_2_info', 'section_3_deep', 'section_4_case', 'section_5_outro',
    'seo_tags', 'cta_box'
  ];
  for (const tag of knownTags) {
    const brokenPattern = tag.split('_').join('(?:_|<[/]?em>)+');
    t = t.replace(new RegExp(`<\\s*${brokenPattern}\\s*>`, 'gi'), `<${tag}>`);
    t = t.replace(new RegExp(`<\\s*\\/\\s*${brokenPattern}\\s*>`, 'gi'), `</${tag}>`);
  }

  return t;
}

function stripNaverMarkdownBoldMarkers(s) {
  return String(s ?? '').replace(/\*\*/g, '');
}

function extractGeminiStyleTagInner(raw, tagName) {
  const s = normalizeRawForNaverTagParse(raw);
  const esc = escapeRegExpForNaverTag(tagName);
  const re = new RegExp(
    `<\\s*${esc}\\s*[^>]*>\\s*([\\s\\S]*?)<\\s*/\\s*${esc}\\s*>`,
    'i',
  );
  const m = s.match(re);
  return m ? String(m[1]).trim() : '';
}

function extractAllGeminiStyleTagInners(raw, tagName) {
  const s = normalizeRawForNaverTagParse(raw);
  const esc = escapeRegExpForNaverTag(tagName);
  const re = new RegExp(
    `<\\s*${esc}\\s*[^>]*>\\s*([\\s\\S]*?)<\\s*/\\s*${esc}\\s*>`,
    'gi',
  );
  const out = [];
  for (const m of s.matchAll(re)) {
    out.push(String(m[1] ?? '').trim());
  }
  return out;
}

/** bg-naver-flow.js parseNaverGeminiTaggedSections */
function parseNaverGeminiTaggedSections(raw) {
  const final_title = stripNaverMarkdownBoldMarkers(
    extractGeminiStyleTagInner(raw, 'final_title'),
  );
  const sections = {};
  for (const name of NAVER_GEMINI_BODY_TAG_ORDER) {
    const inner = stripNaverMarkdownBoldMarkers(extractGeminiStyleTagInner(raw, name));
    if (inner) sections[name] = inner;
  }
  const imgPlaceBlocks = extractAllGeminiStyleTagInners(raw, 'img_place')
    .map((x) => stripNaverMarkdownBoldMarkers(x))
    .filter((x) => x.length);
  if (imgPlaceBlocks.length) sections.img_place = imgPlaceBlocks.join('\n\n');
  return { final_title, sections };
}

function clampNaverFinalTitleInnerBeforeSections(inner) {
  let t = String(inner ?? '');
  const re = /<\s*section[\s_]/i;
  const m = re.exec(t);
  if (m && m.index > 0) t = t.slice(0, m.index);
  return t.trim();
}

function naverFinalTitlePlainFromTaggedInner(inner) {
  let t = clampNaverFinalTitleInnerBeforeSections(inner);
  if (!t.length) return '';
  t = t.replace(/<[^>]+>/g, '').trim();
  t = stripNaverMarkdownBoldMarkers(t);
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

function stripNaverGeminiTaggedBlockOnce(raw, tagName) {
  const s = normalizeRawForNaverTagParse(raw);
  const esc = escapeRegExpForNaverTag(tagName);
  const re = new RegExp(
    `<\\s*${esc}\\s*[^>]*>\\s*[\\s\\S]*?<\\s*/\\s*${esc}\\s*>`,
    'i',
  );
  return s.replace(re, '').trim();
}

function naverBodySectionPlainForPaste(s) {
  let t = String(s ?? '').trim();
  if (!t.length) return '';
  
  // Convert structural HTML tags to newlines before stripping
  t = t.replace(/<\/\s*p\s*>/gi, '\n\n');
  t = t.replace(/<\/\s*div\s*>/gi, '\n');
  t = t.replace(/<\s*br\s*\/?>/gi, '\n');
  t = t.replace(/<\s*li\s*>/gi, '\n• ');
  
  t = t.replace(/<[^>]+>/g, '');
  t = stripNaverMarkdownBoldMarkers(t);
  t = t.replace(/\r\n/g, '\n');
  t = t.replace(/\n{3,}/g, '\n\n'); // condense multiple newlines
  
  return t.trim();
}

function naverBodySeoTagsPlainForPaste(s) {
  const base = naverBodySectionPlainForPaste(s);
  if (!base.length) return '';
  const lines = [];
  for (const part of base.split(/[,，]/)) {
    let t = part.replace(/\s+/g, ' ').trim();
    if (!t.length) continue;
    if (t.startsWith('#')) t = t.slice(1).trim();
    if (!t.length) continue;
    lines.push(`#${t}`);
  }
  return lines.join('\n');
}

function buildNaverBodyTextFromParsedSections(sections) {
  const parts = [];
  for (const key of NAVER_GEMINI_BODY_TAG_ORDER) {
    const v = sections[key];
    if (typeof v !== 'string' || !v.trim()) continue;
    const plain =
      key === 'seo_tags' ? naverBodySeoTagsPlainForPaste(v) : naverBodySectionPlainForPaste(v);
    if (plain.length) parts.push(plain);
  }
  return parts.join('\n\n');
}

function buildNaverBodyTextInDocumentOrder(raw) {
  const normalized = normalizeRawForNaverTagParse(String(raw ?? ''));
  const tagAlt = NAVER_GEMINI_BODY_STREAM_TAGS.map(escapeRegExpForNaverTag).join('|');
  const re = new RegExp(
    `<\\s*(${tagAlt})\\s*[^>]*>\\s*([\\s\\S]*?)<\\s*/\\s*\\1\\s*>`,
    'gi',
  );
  const parts = [];
  for (const m of normalized.matchAll(re)) {
    const tagName = String(m[1] ?? '').toLowerCase();
    const inner = m[2] ?? '';
    let plain = naverBodySectionPlainForPaste(inner);
    if (tagName === 'img_place') {
      // Do not push the image recommendation text into the final body.
      continue;
    } else if (tagName === 'seo_tags') {
      plain = naverBodySeoTagsPlainForPaste(inner);
      if (plain.length) parts.push(plain);
    } else if (plain.length) {
      parts.push(plain);
    }
  }
  if (parts.length) return parts.join('\n\n');
  return buildNaverBodyTextFromParsedSections(parseNaverGeminiTaggedSections(normalized).sections);
}

function looksLikeNaverGeminiTaggedXml(s) {
  const t = String(s ?? '');
  return /<final_title\b/i.test(t) && /<\s*\/\s*final_title\s*>/i.test(t);
}

function stripNaverImageInsertPlaceholdersFromPlain(plain) {
  const s = typeof plain === 'string' ? plain.replace(/\r\n/g, '\n') : '';
  if (!s.length) return s;
  return s
    .replace(/이미지 삽입공간\s*\n?\s*\{[^}]+\}/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Build title/body for Smart Editor paste — bg-naver-flow startNaverWriteWithGeminiRefinedContent.
 * Naver XML: title field stays empty; headline + sections go to body.
 */
function buildNaverPastePayloadFromGeminiContent(rawText) {
  const trimmed = normalizeRawForNaverTagParse(rawText).trim();
  if (!trimmed.length) {
    return { title: '', body: '', parsed: null, looksXml: false, blocks: [] };
  }

  if (!looksLikeNaverGeminiTaggedXml(trimmed)) {
    const body = stripNaverImageInsertPlaceholdersFromPlain(trimmed);
    const blocks = [];
    for (const line of body.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      if (t.indexOf('이미지 삽입공간') === 0) {
        const m = t.match(/^이미지\s*삽입\s*공간\s*[:：]?\s*(.*)$/);
        const subject = m && m[1] ? m[1].trim() : '';
        blocks.push({ type: 'imgplace', text: t, imagePrompt: subject });
      } else {
        blocks.push({ type: 'paragraph', text: t });
      }
    }
    return {
      title: '',
      body,
      parsed: null,
      looksXml: false,
      blocks,
    };
  }

  const parsed = parseNaverGeminiTaggedSections(trimmed);
  const titlePlain = naverFinalTitlePlainFromTaggedInner(parsed.final_title);
  let sectionBody = buildNaverBodyTextInDocumentOrder(trimmed);
  if (!sectionBody.trim()) {
    sectionBody = naverBodySectionPlainForPaste(
      stripNaverGeminiTaggedBlockOnce(trimmed, 'final_title'),
    );
  }

  const bodyParts = [];
  if (sectionBody.trim().length) bodyParts.push(sectionBody.trim());
  const body = stripNaverImageInsertPlaceholdersFromPlain(bodyParts.join('\n\n'));

  const blocks = [];
  for (const key of NAVER_GEMINI_BODY_TAG_ORDER) {
    const v = parsed.sections[key];
    if (typeof v !== 'string' || !v.trim()) continue;
    
    const plain = key === 'seo_tags' ? naverBodySeoTagsPlainForPaste(v) : naverBodySectionPlainForPaste(v);
    if (!plain.length) continue;

    if (key === 'seo_tags') {
      blocks.push({ type: 'paragraph', text: plain });
    } else {
      for (const line of plain.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        if (t.indexOf('이미지 삽입공간') === 0) {
          const m = t.match(/^이미지\s*삽입\s*공간\s*[:：]?\s*(.*)$/);
          const subject = m && m[1] ? m[1].trim() : '';
          blocks.push({ type: 'imgplace', text: t, imagePrompt: subject });
        } else {
          blocks.push({ type: 'paragraph', text: t });
        }
      }
    }
  }

  return {
    title: titlePlain,
    body,
    parsed: {
      final_title: titlePlain,
      sections: parsed.sections,
      bodyText: body,
    },
    looksXml: true,
    blocks,
  };
}

function readTextFile(filePath) {
  const resolved = path.resolve(String(filePath || ''));
  if (!resolved || !fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  return fs.readFileSync(resolved, 'utf8');
}

/**
 * Parse the Gemini JSON prompt output ({ title, blocks:[{type,text}], tags })
 * into the editor paste payload. Only the VALUES go into the editor:
 *   - title  → 제목 칸
 *   - blocks → 본문 (each block's `text`, one paragraph per block)
 * `[[ ... ]]` highlight markers are stripped (plain-text paste).
 * @returns {{ title: string, body: string, parsed: null, blocks: Array }}
 */
function buildNaverPastePayloadFromJson(rawText, options = {}) {
  // 맛집리뷰 직접 이미지 첨부: render every imgplace as a clean fixed placeholder
  // ("이미지 삽입공간") with no subject — the user drops their own image, no AI gen.
  const manualImgPlaceholder = options.manualImgPlaceholder === true;
  let source = String(rawText ?? '').trim();

  // HTML 태그가 포함되어 있을 수 있으므로 태그를 제거하고 디코딩하여 순수 JSON 텍스트 추출 시도.
  source = source
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

  // Strip a wrapping ```json ... ``` fence if present.
  source = source
    .replace(/^﻿/, '')
    .replace(/^```[a-zA-Z]*\s*/, '')
    .replace(/\s*```$/, '')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    return { title: '', body: '', parsed: null, blocks: [] };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { title: '', body: '', parsed: null, blocks: [] };
  }

  const stripHighlight = (s) =>
    String(s || '')
      .replace(/\[\[(.+?)\]\]/g, '$1')
      .replace(/\s+/g, ' ')
      .replace(/\[줄바꿈\]/gi, '\n')
      .trim();

  const title = stripHighlight(parsed.title);
  let rawBlocks = Array.isArray(parsed.blocks) ? parsed.blocks : [];

  // Tolerate a FLATTENED shape some models emit instead of the nested array:
  //   { "block_1_type": "...", "block_1_text": "...", "block_1_highlights": [...],
  //     "block_2_type": "...", ... }
  // Reconstruct the blocks array from block_<n>_* keys (sorted by <n>).
  if (!rawBlocks.length) {
    const idxSet = new Set();
    for (const key of Object.keys(parsed)) {
      const m = /^block_(\d+)_(type|text|highlights)$/.exec(key);
      if (m) idxSet.add(Number(m[1]));
    }
    if (idxSet.size) {
      rawBlocks = Array.from(idxSet)
        .sort((a, b) => a - b)
        .map((n) => {
          const obj = {
            type: typeof parsed[`block_${n}_type`] === 'string' ? parsed[`block_${n}_type`] : 'paragraph',
            text: typeof parsed[`block_${n}_text`] === 'string' ? parsed[`block_${n}_text`] : '',
          };
          const h = parsed[`block_${n}_highlights`];
          if (Array.isArray(h)) obj.highlights = h;
          return obj;
        });
    }
  }
  const blocks = [];
  const lines = [];
  let imgIndex = 0;
  for (const b of rawBlocks) {
    if (!b || typeof b !== 'object') {
      continue;
    }
    let type = typeof b.type === 'string' ? b.type : 'paragraph';
    let rawText = typeof b.text === 'string' ? b.text : '';

    // LLM이 type을 paragraph 등으로 잘못 분류했더라도, 
    // 내용이 "이미지 삽입공간"으로 시작하면 강제로 imgplace 타입으로 보정한다.
    if (type !== 'imgplace' && rawText.trim().indexOf('이미지 삽입공간') === 0) {
      type = 'imgplace';
    }

    // imgplace: the LLM gives an image subject for this section. Render it as
    // "이미지 삽입공간 : {subject}" (as-is, no numbering) and carry the raw
    // subject in `imagePrompt` for the image-generation step.
    if (type === 'imgplace') {
      imgIndex += 1;
      let subject = stripHighlight(rawText);
      // LLM이 통문장으로 "이미지 삽입공간 : ..." 형태로 리턴했을 수 있으므로 접두어를 제거한다.
      const m = subject.match(/^이미지\s*삽입\s*공간\s*[:：]?\s*(.*)$/);
      if (m && m[1]) {
        subject = m[1].trim();
      } else if (subject.indexOf('이미지 삽입공간') === 0) {
        subject = ''; // "이미지 삽입공간" 문구만 덩그러니 있을 때
      }

      // 에디터 상에서 마커가 너무 길면 줄바꿈(Word wrap) 렌더링이 일어나, 삭제 시 텍스트 잔해가 남을 수 있으므로 30자로 자른다.
      const shortSubject = subject.length > 30 ? subject.substring(0, 30) + '...' : subject;

      const marker = manualImgPlaceholder
        ? '이미지 삽입공간'
        : (shortSubject ? `이미지 삽입공간 : ${shortSubject}` : '이미지 삽입공간 :');
      blocks.push({
        type,
        text: marker,
        imagePrompt: manualImgPlaceholder ? '' : subject,
      });
      lines.push(marker);
      continue;
    }

    if (typeof b.text !== 'string') {
      continue;
    }
    let text = stripHighlight(b.text);
    // headings: drop the leading numbering ("1. ", "2. " …).
    if (type === 'heading') {
      text = text.replace(/^\s*\d+\s*\.\s*/, '').trim();
    }
    if (!text) {
      continue;
    }
    const blockObj = { type, text };
    // paragraph/summary may carry "highlights": substrings of `text` to be
    // marked with a background color in the editor. Clean them the same way as
    // `text` and keep only those that actually occur in the cleaned text.
    if ((type === 'paragraph' || type === 'summary') && Array.isArray(b.highlights)) {
      const hls = b.highlights
        .map((h) => stripHighlight(h))
        .filter((h) => h && text.includes(h));
      if (hls.length) {
        blockObj.highlights = hls;
      }
    }
    blocks.push(blockObj);
    lines.push(text);

    // AI sometimes puts imgplace as a field on the heading object instead of a
    // separate { type: 'imgplace' } block. Detect this and synthesize the block.
    // e.g. { "type": "heading", "text": "...", "imgplace": "이미지 설명..." }
    if (type === 'heading' && typeof b.imgplace === 'string' && b.imgplace.trim()) {
      imgIndex += 1;
      let subject = stripHighlight(b.imgplace);
      // Strip any leading "이미지 삽입공간 : " prefix the AI might have added.
      const im = subject.match(/^이미지\s*삽입\s*공간\s*[:：]?\s*(.*)$/);
      if (im && im[1]) subject = im[1].trim();

      // Truncate to 30 chars to avoid word-wrap issues in the editor.
      const shortSubject = subject.length > 30 ? subject.substring(0, 30) + '...' : subject;
      const marker = manualImgPlaceholder
        ? '이미지 삽입공간'
        : (shortSubject ? `이미지 삽입공간 : ${shortSubject}` : '이미지 삽입공간 :');
      blocks.push({ type: 'imgplace', text: marker, imagePrompt: manualImgPlaceholder ? '' : subject });
      lines.push(marker);
    }
  }

  const tags = Array.isArray(parsed.tags)
    ? parsed.tags
        .map((t) => stripHighlight(t))
        .filter(Boolean)
        .slice(0, 30)
    : [];

  // Friendly greeting line placed at the very top of the body (after the
  // thumbnail marker), before the blocks.
  const intro = typeof parsed.intro === 'string' ? stripHighlight(parsed.intro) : '';

  return { title, body: lines.join('\n'), parsed: null, blocks, tags, intro };
}

function logNaverParsedSections(logger, parsed) {
  if (!parsed) return;
  const summary = {
    final_title: parsed.final_title || '',
    sectionKeys: Object.keys(parsed.sections || {}),
    bodyChars: (parsed.bodyText || '').length,
  };
  logger?.info?.(`[NAVER] [PARSE] ${JSON.stringify(summary)}`);
}

/**
 * Validates Gemini Naver XML output before editor paste — final_title + at least one section.
 * @returns {{ valid: boolean, reason?: string, details?: object }}
 */
function validateNaverGeminiTaggedOutput(raw) {
  const text = String(raw ?? '').trim();
  if (!text) {
    return { valid: false, reason: 'empty', details: { code: 'naver_empty' } };
  }

  // Naver now uses the custom JSON prompt ({ title, blocks, tags }). Accept the
  // copied response as-is so a successful Gemini copy is NOT re-run by the
  // compose-retry loop (the old XML-tag validation caused repeated re-runs).
  // Detailed JSON parsing belongs to the naver paste step (added later).
  let format = 'naver_raw';
  let finalTitle = '';
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.title === 'string') {
        finalTitle = parsed.title.trim();
      }
      if (finalTitle || Array.isArray(parsed.blocks)) {
        format = 'naver_json';
      }
    }
  } catch {
    /* not JSON — still accept the copied content */
  }

  return {
    valid: true,
    details: { format, finalTitle, chars: text.length },
  };
}

module.exports = {
  NAVER_GEMINI_BODY_TAG_ORDER,
  NAVER_GEMINI_BODY_STREAM_TAGS,
  NAVER_PUBLISH_SELECTORS,
  normalizeNaverBlogId,
  buildNaverBlogWriteUrl,
  isNaverLoginFailureUrl,
  isNaverBlogWriteSuccessUrl,
  parseNaverGeminiTaggedSections,
  naverFinalTitlePlainFromTaggedInner,
  buildNaverBodyTextInDocumentOrder,
  buildNaverBodyTextFromParsedSections,
  looksLikeNaverGeminiTaggedXml,
  stripNaverImageInsertPlaceholdersFromPlain,
  buildNaverPastePayloadFromGeminiContent,
  buildNaverPastePayloadFromJson,
  readTextFile,
  logNaverParsedSections,
  validateNaverGeminiTaggedOutput,
  naverBodySectionPlainForPaste,
  naverBodySeoTagsPlainForPaste,
};
