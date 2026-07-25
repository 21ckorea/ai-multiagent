'use strict';

/**
 * @file tistory_placeholder_util.js
 * @description 티스토리 이미지 플레이스홀더 파싱 유틸
 * @purpose  HTML에서 이미지 삽입공간 마커를 추출하고, 각 플레이스홀더에 대한
 *           이미지 묘사 텍스트를 파싱하여 Gemini 이미지 요청에 사용 가능한 형태로 반환.
 * @exports  extractTistoryImagePlaceholdersFromHtml, parsePlaceholderText
 * @seeAlso  tistory_placeholder_gate.js
 */


/** Port of jably_blog/lib/tistory-placeholder-util.js */

const TISTORY_PLACEHOLDER_LABEL_TEST_RE = /이미지\s*삽입\s*공간/i;
const TISTORY_PLACEHOLDER_PLAIN_MATCH_RE = TISTORY_PLACEHOLDER_LABEL_TEST_RE;
const TISTORY_PLACEHOLDER_HTML_STRIP_RE_G =
  /[^\n<]*이미지\s*삽입\s*공간[\s\S]*?(?=(?:<\/(?:div|p|section)>|<|$))/gi;
const BLOCK_TAG_RE = /<(div|p|section|li|td|th|blockquote|h[1-6])(\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
const LABEL_ONLY_BLOCK_RE = /^\[?\s*이미지\s*삽입\s*공간(?:\s*\d+)?\s*\]?\s*$/i;

function normalizePlaceholderCompareText(text) {
  return String(text ?? '')
    .replace(/\u200b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsTistoryPlaceholderLabel(text) {
  return TISTORY_PLACEHOLDER_LABEL_TEST_RE.test(String(text ?? '').replace(/\u200b/g, ''));
}

function htmlToPlainTextForPlaceholderScan(html) {
  let source = String(html ?? '');
  source = source.replace(/&#123;|&lbrace;|&#x7B;/gi, '{');
  source = source.replace(/&#125;|&rbrace;|&#x7D;/gi, '}');
  source = source.replace(/&nbsp;|&#160;|&#xA0;/gi, ' ');
  source = source.replace(/<br\s*\/?>/gi, ' ');
  source = source.replace(/<\/p>\s*<p[^>]*>/gi, ' ');
  source = source.replace(/<[^>]+>/g, ' ');
  source = source.replace(/\u200b/g, '');
  source = source.replace(/\s+/g, ' ');
  return source.trim();
}

function parsePlaceholderFromPlainBlock(plain) {
  const text = normalizePlaceholderCompareText(plain);
  if (!containsTistoryPlaceholderLabel(text)) {
    return null;
  }

  const fullPlaceholderLine = text;
  const braceMatch = text.match(/이미지\s*삽입\s*공간[\s\S]*?\{([^}]+)\}/i);
  if (braceMatch?.[1]?.trim()) {
    return { imageInnerPrompt: braceMatch[1].trim(), fullPlaceholderLine };
  }

  const bracketMatch = text.match(/\[?\s*이미지\s*삽입\s*공간(?:\s*\d+)?\s*[：:]\s*([^\]]+)\]/i);
  if (bracketMatch?.[1]?.trim()) {
    return { imageInnerPrompt: bracketMatch[1].trim(), fullPlaceholderLine };
  }

  const colonMatch = text.match(/이미지\s*삽입\s*공간(?:\s*\d+)?\s*[：:]\s*(.+)/i);
  if (colonMatch?.[1]?.trim()) {
    return { imageInnerPrompt: colonMatch[1].trim(), fullPlaceholderLine };
  }

  return { imageInnerPrompt: text, fullPlaceholderLine };
}

function isBraceOnlyPlaceholderTail(plain) {
  return /^\{[^}]+\}$/.test(normalizePlaceholderCompareText(plain));
}

function extractFromPlainSegments(plain) {
  const source = normalizePlaceholderCompareText(plain);
  if (!containsTistoryPlaceholderLabel(source)) {
    return [];
  }

  const re = /\[?\s*이미지\s*삽입\s*공간/gi;
  const indices = [];
  let match;
  while ((match = re.exec(source)) !== null) {
    let start = match.index;
    if (start > 0 && source[start - 1] === '[') {
      start -= 1;
    }
    indices.push(start);
  }

  const out = [];
  for (let i = 0; i < indices.length; i += 1) {
    const segment = source.slice(indices[i], i + 1 < indices.length ? indices[i + 1] : source.length).trim();
    const parsed = parsePlaceholderFromPlainBlock(segment);
    if (parsed?.imageInnerPrompt) {
      out.push(parsed);
    }
  }
  return out;
}

function extractInnerContentOfOutermostDiv(html) {
  const source = String(html ?? '').trim();
  const firstMatch = source.match(/<div\b[^>]*>/i);
  if (!firstMatch) {
    return source;
  }
  const first = source.indexOf(firstMatch[0]);
  const startContentIdx = first + firstMatch[0].length;

  const divPairRe = /<\/?div\b[^>]*>/gi;
  divPairRe.lastIndex = startContentIdx;
  let depth = 1;
  let match;
  while ((match = divPairRe.exec(source)) !== null) {
    const tag = match[0];
    if (/^<\//i.test(tag)) {
      depth -= 1;
      if (depth === 0) {
        const endContentIdx = divPairRe.lastIndex - tag.length;
        const rest = source.slice(divPairRe.lastIndex).trim();
        if (rest.length === 0 || !/<\s*\/?\s*[a-z][\w:-]*/i.test(rest)) {
          return source.slice(startContentIdx, endContentIdx).trim();
        }
        break;
      }
    } else {
      depth += 1;
    }
  }
  return source;
}

function extractTistoryImagePlaceholdersFromHtml(html) {
  const stripped = extractInnerContentOfOutermostDiv(html);
  const source = String(stripped ?? '');
  const out = [];
  const blockRe = new RegExp(BLOCK_TAG_RE.source, 'gi');
  let blockMatch;

  while ((blockMatch = blockRe.exec(source)) !== null) {
    const inner = blockMatch[3];
    const blockPlain = htmlToPlainTextForPlaceholderScan(inner);

    if (!containsTistoryPlaceholderLabel(blockPlain)) {
      if (out.length > 0 && isBraceOnlyPlaceholderTail(blockPlain)) {
        const prev = out[out.length - 1];
        const tailPrompt = blockPlain.slice(1, -1).trim();
        if (tailPrompt && LABEL_ONLY_BLOCK_RE.test(prev.fullPlaceholderLine)) {
          prev.imageInnerPrompt = tailPrompt;
        }
      }
      continue;
    }

    if (LABEL_ONLY_BLOCK_RE.test(blockPlain)) {
      out.push({
        imageInnerPrompt: blockPlain,
        fullPlaceholderLine: blockPlain,
      });
      continue;
    }

    const parsed = parsePlaceholderFromPlainBlock(blockPlain);
    if (parsed?.imageInnerPrompt) {
      out.push(parsed);
    }
  }

  if (out.length > 0) {
    return out;
  }

  if (containsTistoryPlaceholderLabel(source)) {
    return extractFromPlainSegments(htmlToPlainTextForPlaceholderScan(source));
  }

  return out;
}

function countTistoryPlaceholdersInPlain(plain) {
  return extractFromPlainSegments(plain).length;
}

function countTistoryPlaceholdersInHtml(html) {
  return extractTistoryImagePlaceholdersFromHtml(html).length;
}

function stripPlaceholderBlocksFromHtmlOnce(html) {
  const blockRe = new RegExp(BLOCK_TAG_RE.source, 'gi');
  return String(html ?? '').replace(blockRe, (full, _tag, _attrs, inner) => {
    const plain = htmlToPlainTextForPlaceholderScan(inner);
    return containsTistoryPlaceholderLabel(plain) || isBraceOnlyPlaceholderTail(plain) ? '' : full;
  });
}

function stripBraceOnlyBlocksFromHtmlOnce(html) {
  const blockRe = new RegExp(BLOCK_TAG_RE.source, 'gi');
  return String(html ?? '').replace(blockRe, (full, _tag, _attrs, inner) => {
    const plain = htmlToPlainTextForPlaceholderScan(inner);
    return isBraceOnlyPlaceholderTail(plain) ? '' : full;
  });
}

function stripTistoryPlaceholderMarkupFromHtml(html) {
  let value = String(html ?? '');
  for (let i = 0; i < 8; i += 1) {
    const next = stripPlaceholderBlocksFromHtmlOnce(value);
    if (next === value) {
      break;
    }
    value = next;
  }
  for (let i = 0; i < 4; i += 1) {
    const next = stripBraceOnlyBlocksFromHtmlOnce(value);
    if (next === value) {
      break;
    }
    value = next;
  }
  value = value.replace(/<(div|p|section)[^>]*>\s*<\/\1>/gi, '');
  return value;
}

/**
 * MAIN-world install — jably_blog/lib/tistory-placeholder-util-main.js parity.
 * Self-contained for Playwright page.evaluate serialization.
 */
function installTistoryPlaceholderUtilMain() {
  if (window.__jablyTistoryPlaceholderUtil) {
    return;
  }

  const TISTORY_PLACEHOLDER_LABEL_TEST_RE = /이미지\s*삽입\s*공간/i;
  const TISTORY_PLACEHOLDER_PLAIN_MATCH_RE = TISTORY_PLACEHOLDER_LABEL_TEST_RE;
  const TISTORY_PLACEHOLDER_HTML_STRIP_RE_G =
    /[^\n<]*이미지\s*삽입\s*공간[\s\S]*?(?=(?:<\/(?:div|p|section)>|<|$))/gi;
  const BLOCK_TAG_RE = /<(div|p|section|li|td|th|blockquote|h[1-6])(\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
  const LABEL_ONLY_BLOCK_RE = /^\[?\s*이미지\s*삽입\s*공간(?:\s*\d+)?\s*\]?\s*$/i;

  function normalizePlaceholderCompareText(text) {
    return String(text ?? '')
      .replace(/\u200b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function containsTistoryPlaceholderLabel(text) {
    return TISTORY_PLACEHOLDER_LABEL_TEST_RE.test(String(text ?? '').replace(/\u200b/g, ''));
  }

  function htmlToPlainTextForPlaceholderScan(html) {
    let s = String(html ?? '');
    s = s.replace(/&#123;|&lbrace;|&#x7B;/gi, '{');
    s = s.replace(/&#125;|&rbrace;|&#x7D;/gi, '}');
    s = s.replace(/&nbsp;|&#160;|&#xA0;/gi, ' ');
    s = s.replace(/<br\s*\/?>/gi, ' ');
    s = s.replace(/<\/p>\s*<p[^>]*>/gi, ' ');
    s = s.replace(/<[^>]+>/g, ' ');
    s = s.replace(/\u200b/g, '');
    s = s.replace(/\s+/g, ' ');
    return s.trim();
  }

  function parsePlaceholderFromPlainBlock(plain) {
    const t = normalizePlaceholderCompareText(plain);
    if (!containsTistoryPlaceholderLabel(t)) return null;
    const fullPlaceholderLine = t;
    const braceM = t.match(/이미지\s*삽입\s*공간[\s\S]*?\{([^}]+)\}/i);
    if (braceM?.[1]?.trim()) return { imageInnerPrompt: braceM[1].trim(), fullPlaceholderLine };
    const bracketM = t.match(/\[?\s*이미지\s*삽입\s*공간(?:\s*\d+)?\s*[：:]\s*([^\]]+)\]/i);
    if (bracketM?.[1]?.trim()) return { imageInnerPrompt: bracketM[1].trim(), fullPlaceholderLine };
    const colonM = t.match(/이미지\s*삽입\s*공간(?:\s*\d+)?\s*[：:]\s*(.+)/i);
    if (colonM?.[1]?.trim()) return { imageInnerPrompt: colonM[1].trim(), fullPlaceholderLine };
    return { imageInnerPrompt: t, fullPlaceholderLine };
  }

  function isBraceOnlyPlaceholderTail(plain) {
    return /^\{[^}]+\}$/.test(normalizePlaceholderCompareText(plain));
  }

  function extractFromPlainSegments(plain) {
    const s = normalizePlaceholderCompareText(plain);
    if (!containsTistoryPlaceholderLabel(s)) return [];
    const re = /\[?\s*이미지\s*삽입\s*공간/gi;
    const indices = [];
    let m;
    while ((m = re.exec(s)) !== null) {
      let start = m.index;
      if (start > 0 && s[start - 1] === '[') start -= 1;
      indices.push(start);
    }
    const out = [];
    for (let i = 0; i < indices.length; i += 1) {
      const segment = s.slice(indices[i], i + 1 < indices.length ? indices[i + 1] : s.length).trim();
      const parsed = parsePlaceholderFromPlainBlock(segment);
      if (parsed?.imageInnerPrompt) out.push(parsed);
    }
    return out;
  }

  function extractTistoryImagePlaceholdersFromHtml(html) {
    const h = String(html ?? '');
    const out = [];
    const blockRe = new RegExp(BLOCK_TAG_RE.source, 'gi');
    let bm;
    while ((bm = blockRe.exec(h)) !== null) {
      const inner = bm[3];
      const blockPlain = htmlToPlainTextForPlaceholderScan(inner);
      if (!containsTistoryPlaceholderLabel(blockPlain)) {
        if (out.length > 0 && isBraceOnlyPlaceholderTail(blockPlain)) {
          const prev = out[out.length - 1];
          const tailPrompt = blockPlain.slice(1, -1).trim();
          if (tailPrompt && LABEL_ONLY_BLOCK_RE.test(prev.fullPlaceholderLine)) {
            prev.imageInnerPrompt = tailPrompt;
          }
        }
        continue;
      }
      if (LABEL_ONLY_BLOCK_RE.test(blockPlain)) {
        out.push({ imageInnerPrompt: blockPlain, fullPlaceholderLine: blockPlain });
        continue;
      }
      const parsed = parsePlaceholderFromPlainBlock(blockPlain);
      if (parsed?.imageInnerPrompt) out.push(parsed);
    }
    if (out.length > 0) return out;
    if (containsTistoryPlaceholderLabel(h)) {
      return extractFromPlainSegments(htmlToPlainTextForPlaceholderScan(h));
    }
    return out;
  }

  function countTistoryPlaceholdersInPlain(plain) {
    return extractFromPlainSegments(plain).length;
  }

  function countTistoryPlaceholdersInHtml(html) {
    return extractTistoryImagePlaceholdersFromHtml(html).length;
  }

  function stripPlaceholderBlocksFromHtmlOnce(html) {
    const blockRe = new RegExp(BLOCK_TAG_RE.source, 'gi');
    return String(html ?? '').replace(blockRe, (full, _tag, _attrs, inner) => {
      const plain = htmlToPlainTextForPlaceholderScan(inner);
      return containsTistoryPlaceholderLabel(plain) || isBraceOnlyPlaceholderTail(plain) ? '' : full;
    });
  }

  function stripBraceOnlyBlocksFromHtmlOnce(html) {
    const blockRe = new RegExp(BLOCK_TAG_RE.source, 'gi');
    return String(html ?? '').replace(blockRe, (full, _tag, _attrs, inner) => {
      const plain = htmlToPlainTextForPlaceholderScan(inner);
      return isBraceOnlyPlaceholderTail(plain) ? '' : full;
    });
  }

  function stripTistoryPlaceholderMarkupFromHtml(html) {
    let v = String(html ?? '');
    for (let i = 0; i < 8; i += 1) {
      const next = stripPlaceholderBlocksFromHtmlOnce(v);
      if (next === v) break;
      v = next;
    }
    for (let i = 0; i < 4; i += 1) {
      const next = stripBraceOnlyBlocksFromHtmlOnce(v);
      if (next === v) break;
      v = next;
    }
    v = v.replace(/<(div|p|section)[^>]*>\s*<\/\1>/gi, '');
    return v;
  }

  window.__jablyTistoryPlaceholderUtil = {
    htmlToPlainTextForPlaceholderScan,
    containsTistoryPlaceholderLabel,
    normalizePlaceholderCompareText,
    parsePlaceholderFromPlainBlock,
    extractFromPlainSegments,
    countTistoryPlaceholdersInPlain,
    countTistoryPlaceholdersInHtml,
    extractTistoryImagePlaceholdersFromHtml,
    stripTistoryPlaceholderMarkupFromHtml,
    TISTORY_PLACEHOLDER_LABEL_TEST_RE,
    TISTORY_PLACEHOLDER_HTML_STRIP_RE_G,
    PLACEHOLDER_PLAIN_MATCH_RE: TISTORY_PLACEHOLDER_PLAIN_MATCH_RE,
  };
}

module.exports = {
  TISTORY_PLACEHOLDER_LABEL_TEST_RE,
  TISTORY_PLACEHOLDER_HTML_STRIP_RE_G,
  normalizePlaceholderCompareText,
  containsTistoryPlaceholderLabel,
  htmlToPlainTextForPlaceholderScan,
  parsePlaceholderFromPlainBlock,
  extractTistoryImagePlaceholdersFromHtml,
  countTistoryPlaceholdersInPlain,
  countTistoryPlaceholdersInHtml,
  stripTistoryPlaceholderMarkupFromHtml,
  installTistoryPlaceholderUtilMain,
};
