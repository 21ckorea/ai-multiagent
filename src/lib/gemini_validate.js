'use strict';

/**
 * @file gemini_validate.js
 * @description Gemini 응답 HTML/JSON 검증 및 정제
 * @purpose  Gemini가 반환한 HTML/JSON 응답의 유효성을 검사하고, 불필요한 마커·
 *           이미지 플레이스홀더·잘못된 형식 등을 정제하여 발행 가능한 형태로 변환.
 * @exports  validateGeminiHtml, cleanGeminiResponse, extractTistoryImagePlaceholders
 * @seeAlso  gemini_compose.js, tistory_editor_inject.js
 */


const fs = require('fs');
const path = require('path');

/** Minimum HTML length (bg-gemini-flow.js GEMINI_OUTPUT_MIN_CHARS). */
const GEMINI_OUTPUT_MIN_CHARS = 500;

const GEMINI_CLIPBOARD_SLASH_LIKE = /[\u005C\uFF3C\u2216\u29F5\uFE68\u29F9\u20E5]/g;
const GEMINI_DIV_TAG_PAIR_RE = /<\/?div\b[^>]*>/gi;
const BLOCK_TAG_RE = /<(div|p|section|li|td|th|blockquote|h[1-6])(\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
const TISTORY_PLACEHOLDER_LABEL_TEST_RE = /이미지\s*삽입\s*공간/i;
const LABEL_ONLY_BLOCK_RE = /^\[?\s*이미지\s*삽입\s*공간(?:\s*\d+)?\s*\]?\s*$/i;

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isMarkdownFenceOnlyLine(line) {
  let text = String(line)
    .replace(/\u200B/g, '')
    .replace(/\uFEFF/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\r/g, '')
    .trim();
  if (!text) {
    return false;
  }
  try {
    text = text.normalize('NFKC');
  } catch {
    /* ignore */
  }
  if (/[<>]/.test(text)) {
    return false;
  }
  return /^(```+|~~~+)\s*[\w#.+\-]*\s*$/u.test(text);
}

function stripOuterMarkdownFenceLines(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  while (lines.length && isMarkdownFenceOnlyLine(lines[0])) {
    lines.shift();
  }
  while (lines.length && isMarkdownFenceOnlyLine(lines[lines.length - 1])) {
    lines.pop();
  }
  return lines.join('\n');
}

function extractOutermostDivWrapper(html) {
  const source = String(html ?? '');
  const first = source.toLowerCase().search(/<div\b/);
  if (first === -1) {
    return source.trim();
  }

  GEMINI_DIV_TAG_PAIR_RE.lastIndex = first;
  let depth = 0;
  let match;
  while ((match = GEMINI_DIV_TAG_PAIR_RE.exec(source)) !== null) {
    const tag = match[0];
    if (/^<\//i.test(tag)) {
      depth -= 1;
      if (depth === 0) {
        const end = GEMINI_DIV_TAG_PAIR_RE.lastIndex;
        const chunk = source.slice(first, end).trim();
        const rest = source.slice(end).trim();
        const restLooksLikeMoreMarkup =
          rest.length > 12 && /<\s*\/?\s*[a-z][\w:-]*/i.test(rest);
        if (restLooksLikeMoreMarkup) {
          return source.trim();
        }
        if (source.length > 500 && chunk.length < source.length * 0.4) {
          return source.trim();
        }
        return chunk;
      }
      if (depth < 0) {
        break;
      }
    } else {
      depth += 1;
    }
  }
  return source.trim();
}

function looksLikeNaverGeminiXmlPayload(text) {
  const value = String(text ?? '');
  return /<final_title\b/i.test(value) && /<\s*\/\s*final_title\s*>/i.test(value);
}

/** Gemini SPA shell accidentally copied as article HTML (Playwright text/html path). */
function looksLikeGeminiAppUiHtml(html) {
  const value = String(html ?? '');
  if (value.length < 200) {
    return false;
  }
  let hits = 0;
  if (/_ngcontent-/i.test(value)) hits += 1;
  if (/markdown-main-panel/i.test(value)) hits += 1;
  if (/inline-copy-host/i.test(value)) hits += 1;
  if (/response-element/i.test(value)) hits += 1;
  if (/model-response-message-content/i.test(value)) hits += 1;
  return hits >= 2 || (/_ngcontent-/i.test(value) && /markdown-main-panel/i.test(value));
}

/** Chrome extension/UI error strings that must not be treated as Gemini HTML. */
function isSpuriousNonGeminiClipboardText(text) {
  const value = String(text ?? '').trim();
  if (!value) {
    return false;
  }
  if (/Invalid value for bounds/i.test(value) && /visible screen space/i.test(value)) {
    return true;
  }
  if (/Bounds must be at least\s*50%/i.test(value)) {
    return true;
  }
  return false;
}

function sanitizeGeminiClipboardHtmlPayload(text) {
  let source = String(text ?? '').replace(/^\uFEFF+/, '');
  source = source.replace(/\u200B/g, '');
  try {
    source = source.normalize('NFKC');
  } catch {
    /* ignore */
  }
  source = source
    .split(/\r?\n/)
    .filter((line) => !isMarkdownFenceOnlyLine(line))
    .join('\n');
  source = stripOuterMarkdownFenceLines(source);
  let prev;
  do {
    prev = source;
    source = source.replace(GEMINI_CLIPBOARD_SLASH_LIKE, '');
  } while (source !== prev);
  source = source.replace(/\n{3,}/g, '\n\n').trim();
  if (looksLikeNaverGeminiXmlPayload(source)) {
    return source;
  }
  return extractOutermostDivWrapper(source);
}

/**
 * Validates Gemini HTML before Tistory handoff (bg-gemini-flow.js validateGeminiOutput).
 * @param {string} html
 * @param {{ flowTarget?: string, minChars?: number }} [options]
 * @returns {{ valid: boolean, reason?: string, details?: object }}
 */
function validateGeminiOutput(html, options = {}) {
  if (typeof html !== 'string' || !html.trim()) {
    return { valid: false, reason: 'empty', details: { code: 'empty_refined_html' } };
  }
  const trimmed = html.trim();
  const minChars = options.minChars || 1000;
  if (trimmed.length < minChars) {
    return { valid: false, reason: 'too_short', details: { code: 'length_fail', chars: trimmed.length, minChars } };
  }
  return { valid: true, details: { format: 'any', chars: trimmed.length } };
}

function applyHeroTitleColorToH1Block(h1Block, titleColor) {
  const color = typeof titleColor === 'string' && titleColor.trim() ? titleColor.trim() : '#ffffff';
  const extras =
    "margin:0;line-height:1.35;font-family:'Pretendard Variable','Pretendard',sans-serif;color:" +
    color;
  return h1Block.replace(/^<h1\b([^>]*)>/i, (_, attrs) => {
    const raw = attrs || '';
    if (dq) {
      const prev = dq[1];
      const merged = (prev + ';' + extras).replace(/;+/g, ';').replace(/^;/, '').replace(/;$/, '');
      const newAttrs = raw.replace(dq[0], `style="${merged}"`);
      return `<h1${newAttrs}>`;
    }
    if (sq) {
      const prev = sq[1];
      const merged = (prev + ';' + extras).replace(/;+/g, ';').replace(/^;/, '').replace(/;$/, '');
      const newAttrs = raw.replace(sq[0], `style='${merged}'`);
      return `<h1${newAttrs}>`;
    }
    const rest = raw.trim();
    return rest ? `<h1 style="${extras}" ${rest}>` : `<h1 style="${extras}">`;
  });
}

function wrapFirstH1WithHeroCardBackground(html, heroStyle) {
  if (!heroStyle || (!heroStyle.bg1 && !heroStyle.bg2)) {
    return html;
  }
  if (typeof html !== 'string' || !/<h1\b/i.test(html)) {
    return html;
  }
  const re = /<h1\b[^>]*>[\s\S]*?<\/h1>/i;
  const match = html.match(re);
  if (!match) {
    return html;
  }
  const bg =
    heroStyle.gradient !== false && heroStyle.bg1 && heroStyle.bg2
      ? `background: linear-gradient(135deg, ${heroStyle.bg1}, ${heroStyle.bg2})`
      : `background: ${heroStyle.bg1 || heroStyle.bg2}`;
  const titleColor = heroStyle.textColor || '#ffffff';
  const innerH1 = applyHeroTitleColorToH1Block(match[0], titleColor);
  const wrapperStyle = `${bg}; border-radius: 18px; padding: 38px 32px 32px; margin: 0 auto 28px; max-width: 900px; box-shadow: 0 4px 24px rgba(0,0,0,.12); text-align: center;`;
  return html.replace(re, `<div style="${wrapperStyle}">${innerH1}</div>`);
}

function buildStaticCtaBoxHtml(ctaDesign, representativeLine = '') {
  if (!ctaDesign) {
    return '';
  }
  const headline = (ctaDesign.ctaHeadline || '').trim();
  const rep = typeof representativeLine === 'string' ? representativeLine.trim() : '';
  const primaryTop = rep || headline;
  const texts = Array.isArray(ctaDesign.ctaTexts)
    ? ctaDesign.ctaTexts.filter((t) => (t || '').trim())
    : [];
  const btnLabel = (ctaDesign.ctaBtnLabel || '').trim();
  const link = (ctaDesign.ctaLink || '').trim();
  if (!primaryTop && !texts.length && !btnLabel) {
    return '';
  }
  const s = ctaDesign.ctaStyle || {};
  const bg =
    s.gradient !== false && s.bg1 && s.bg2
      ? `background: linear-gradient(135deg, ${s.bg1}, ${s.bg2})`
      : s.bg1
        ? `background: ${s.bg1}`
        : 'background: #1e293b';
  const textColor = s.textColor || '#ffffff';
  const btnBg = s.btnColor || '#3b82f6';
  const btnTextColor = s.btnTextColor || textColor;
  let inner = '';
  if (primaryTop) {
    inner += `<h2 style="margin:0 0 16px; font-size:2rem; font-weight:800; color:${textColor}; line-height:1.35; font-family:'Pretendard Variable','Pretendard',sans-serif; text-align:center;">${escapeHtml(primaryTop)}</h2>`;
  }
  if (headline && headline !== primaryTop) {
    inner += `<h3 style="margin:0 0 12px; font-size:1.3rem; font-weight:700; color:${textColor}; text-align:center;">${escapeHtml(headline)}</h3>`;
  }
  if (texts.length) {
    inner += texts
      .map(
        (t) =>
          `<p style="margin:4px 0; font-size:1rem; color:${textColor}; line-height:1.7; text-align:center;">${escapeHtml(t)}</p>`,
      )
      .join('');
  }
  if (btnLabel && link) {
    inner +=
      `<a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer" ` +
      `style="display:inline-block; margin-top:16px; padding:12px 28px; background:${btnBg}; color:${btnTextColor}; ` +
      `font-size:1rem; font-weight:700; border-radius:8px; text-decoration:none; text-align:center;">` +
      `${escapeHtml(btnLabel)}</a>`;
  } else if (btnLabel) {
    inner += `<p style="margin-top:12px; font-size:1rem; font-weight:700; color:${textColor}; text-align:center;">${escapeHtml(btnLabel)}</p>`;
  }
  return (
    `<div style="${bg}; border-radius: 14px; padding: 28px 24px; margin: 32px auto 0; max-width: 900px; box-shadow: 0 2px 16px rgba(0,0,0,.10); text-align: center;">` +
    inner +
    '</div>'
  );
}

function wrapBodyWithStaticHeroCta(bodyHtml, ctaDesign, titleText) {
  if (!ctaDesign || typeof ctaDesign !== 'object') {
    return bodyHtml;
  }
  let body = typeof bodyHtml === 'string' ? bodyHtml : '';
  const beforeH1Wrap = body;
  body = wrapFirstH1WithHeroCardBackground(body, ctaDesign.heroStyle);
  const cta = buildStaticCtaBoxHtml(ctaDesign, titleText);
  const h1Wrapped = body !== beforeH1Wrap;
  if (!cta && !h1Wrapped) {
    return bodyHtml;
  }
  return body + (cta ? '\n' + cta : '');
}

/**
 * wrapGeminiDraftHtmlForTistoryPrefill parity without chrome.storage.
 * @param {string} html
 * @param {{ ctaDesign?: object, titleText?: string, flowTarget?: string, workflowKind?: string }} [options]
 */
function wrapForTistoryPrefill(html, options = {}) {
  const raw = typeof html === 'string' ? html : '';
  if (!raw.trim()) {
    return raw;
  }
  if (options.workflowKind === 'geminiImage') {
    return raw;
  }
  if (options.flowTarget === 'naver') {
    return raw;
  }
  const ctaDesign =
    options.ctaDesign && typeof options.ctaDesign === 'object' ? options.ctaDesign : null;
  if (!ctaDesign) {
    return raw;
  }
  const titleText =
    String(options.titleText || ctaDesign.ctaHeadline || '').trim() ||
    String(options.topicFallback || '').trim();
  return wrapBodyWithStaticHeroCta(raw, ctaDesign, titleText);
}

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
    return { prompt: braceMatch[1].trim(), fullPlaceholderLine, imageInnerPrompt: braceMatch[1].trim() };
  }

  const bracketMatch = text.match(/\[?\s*이미지\s*삽입\s*공간(?:\s*\d+)?\s*[：:]\s*([^\]]+)\]/i);
  if (bracketMatch?.[1]?.trim()) {
    return {
      prompt: bracketMatch[1].trim(),
      fullPlaceholderLine,
      imageInnerPrompt: bracketMatch[1].trim(),
    };
  }

  const colonMatch = text.match(/이미지\s*삽입\s*공간(?:\s*\d+)?\s*[：:]\s*(.+)/i);
  if (colonMatch?.[1]?.trim()) {
    return {
      prompt: colonMatch[1].trim(),
      fullPlaceholderLine,
      imageInnerPrompt: colonMatch[1].trim(),
    };
  }

  return { prompt: text, fullPlaceholderLine, imageInnerPrompt: text };
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
    if (parsed?.prompt) {
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

/** tistory-placeholder-util.js extractTistoryImagePlaceholdersFromHtml parity. */
function extractImagePlaceholders(html) {
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
          prev.prompt = tailPrompt;
          prev.imageInnerPrompt = tailPrompt;
        }
      }
      continue;
    }

    if (LABEL_ONLY_BLOCK_RE.test(blockPlain)) {
      out.push({
        prompt: blockPlain,
        fullPlaceholderLine: blockPlain,
        imageInnerPrompt: blockPlain,
      });
      continue;
    }

    const parsed = parsePlaceholderFromPlainBlock(blockPlain);
    if (parsed?.prompt) {
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

function replaceInlineMarkdown(text) {
  let res = text;
  res = res.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  res = res.replace(/__(.*?)__/g, '<strong>$1</strong>');
  res = res.replace(/\*(.*?)\*/g, '<em>$1</em>');
  res = res.replace(/_(.*?)_/g, '<em>$1</em>');
  res = res.replace(/`(.*?)`/g, '<code>$1</code>');
  return res;
}

function convertMarkdownToHtml(text) {
  if (typeof text !== 'string') return '';
  const blocks = text.split(/\n\s*\n+/);
  const htmlBlocks = blocks.map(block => {
    let trimmed = block.trim();
    if (!trimmed) return '';
    const headerMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headerMatch) {
      const level = headerMatch[1].length;
      let content = headerMatch[2];
      content = replaceInlineMarkdown(content);
      return `<h${level}>${content}</h${level}>`;
    }
    if (trimmed.startsWith('* ') || trimmed.startsWith('- ') || trimmed.startsWith('• ')) {
      const items = trimmed.split(/\n\s*[*•\-]\s+/);
      const firstItem = trimmed.replace(/^[*•\-]\s+/, '');
      items[0] = firstItem;
      const liHtml = items
        .map(item => `<li>${replaceInlineMarkdown(item.trim())}</li>`)
        .join('');
      return `<ul>${liHtml}</ul>`;
    }
    if (trimmed.includes('|') && trimmed.includes('\n')) {
      const lines = trimmed.split('\n').map(l => l.trim());
      if (lines.length > 1 && /^[\s|:-]+$/.test(lines[1]) && lines[1].includes('|')) {
        let tableHtml = '<table border="1" style="border-collapse: collapse; width: 100%;">\n';
        lines.forEach((line, index) => {
          if (index === 1) return;
          let cells = line.split('|').map(c => c.trim());
          if (cells.length > 1 && cells[0] === '') cells.shift();
          if (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
          tableHtml += '  <tr>\n';
          cells.forEach(cell => {
            const tag = index === 0 ? 'th' : 'td';
            tableHtml += `    <${tag}>${replaceInlineMarkdown(cell)}</${tag}>\n`;
          });
          tableHtml += '  </tr>\n';
        });
        tableHtml += '</table>';
        return tableHtml;
      }
    }
    let content = replaceInlineMarkdown(trimmed);
    content = content.replace(/\r?\n/g, '<br>');
    return `<p>${content}</p>`;
  });
  return htmlBlocks.filter(Boolean).join('\n');
}

function cleanupAIArtifacts(text) {
  let res = String(text ?? '');
  
  // 1. Remove AI preambles
  res = res.replace(/<p[^>]*>[\s\u200B]*티스토리 블로그에 바로 올리실 수 있도록[^<]*<\/p>/gi, '');
  res = res.replace(/티스토리 블로그에 바로 올리실 수 있도록 가독성이 좋고 흥미로운 톤으로 작성한 블로그 포스트입니다\.?/gi, '');
  
  res = res.replace(/<p[^>]*>[\s\u200B]*이번에는 티스토리에 바로 복사해서 사용하실 수 있도록[^<]*<\/p>/gi, '');
  res = res.replace(/이번에는 티스토리에 바로 복사해서 사용하실 수 있도록 제목부터 본문, 이미지 플레이스홀더, 해시태그까지 깔끔하게 정리된 블로그 포스트를 작성해 드립니다\.?/gi, '');

  res = res.replace(/<p[^>]*>[\s\u200B]*여기\s*요청하신[^<]*블로그 포스트[^<]*<\/p>/gi, '');
  res = res.replace(/<p[^>]*>[\s\u200B]*다음은[^<]*작성한 블로그 포스트[^<]*<\/p>/gi, '');
  res = res.replace(/<p[^>]*>[\s\u200B]*블로그 포스트 초안입니다\.?[\s\u200B]*<\/p>/gi, '');
  
  // 2. Remove "---" or <hr>
  res = res.replace(/^---+\s*$/gm, '');
  res = res.replace(/<hr\s*\/?>/gi, '');
  
  // 3. Remove stray ">" at the bottom
  res = res.replace(/(?:<p[^>]*>)?[\s\u200B]*(?:&gt;|>|＞)[\s\u200B]*(?:<\/p>)?[\s\u200B]*$/i, '');
  
  return res;
}

/**
 * Sanitize raw clipboard text, then validate. Returns refined HTML or failure reason.
 */
function refineGeminiHtml(raw) {
  if (isSpuriousNonGeminiClipboardText(raw)) {
    return { ok: false, reason: 'spurious_clipboard', html: '' };
  }
  let cleaned = sanitizeGeminiClipboardHtmlPayload(raw);
  cleaned = cleanupAIArtifacts(cleaned);
  
  if (!cleaned.trim()) {
    return { ok: false, reason: 'empty_refined_html', html: '' };
  }
  const hasHtmlTags = /<\s*(p|div|h[1-6]|span|br|strong|b|em|i|ul|ol|li)\b/i.test(cleaned);
  if (!hasHtmlTags) {
    return { ok: true, html: convertMarkdownToHtml(cleaned) };
  }
  return { ok: true, html: cleaned };
}

function writeHtmlOutput(html, outputFile) {
  const target = path.resolve(outputFile);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, String(html ?? ''), 'utf8');
  return target;
}

function logHtmlHandoff(logger, html, outputFile) {
  const text = String(html ?? '');
  const placeholders = extractImagePlaceholders(text);
  const payload = {
    chars: text.length,
    path: outputFile ? path.resolve(outputFile) : '',
    placeholderCount: placeholders.length,
    preview: text.slice(0, 120),
  };
  logger.info(`[Gemini] [HTML] ${JSON.stringify(payload)}`);
  return payload;
}

module.exports = {
  GEMINI_OUTPUT_MIN_CHARS,
  isSpuriousNonGeminiClipboardText,
  looksLikeGeminiAppUiHtml,
  sanitizeGeminiClipboardHtmlPayload,
  validateGeminiOutput,
  refineGeminiHtml,
  wrapForTistoryPrefill,
  wrapBodyWithStaticHeroCta,
  extractImagePlaceholders,
  writeHtmlOutput,
  logHtmlHandoff,
  looksLikeNaverGeminiXmlPayload,
  extractOutermostDivWrapper,
};
