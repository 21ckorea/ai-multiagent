'use strict';

/**
 * @file gemini_naver_prompt.js
 * @description 네이버 블로그 Gemini 프롬프트 빌더 (단일 출처)
 * @purpose  로컬 템플릿 파일(gemini-naver-template.txt) 또는 서버 캐시에서
 *           네이버 블로그 SEO 프롬프트를 읽어 {{TOPIC}}, {{BLOG_ALIAS}} 치환 후 반환.
 * @promptFiles  automation/prompts/gemini-naver-template.txt
 * @exports  buildNaverPrompt, getGeminiNaverLocalPromptTemplate,
 *           getGeminiNaverServerFallbackTemplate, appendTopicToNaverPromptBase
 * @seeAlso  gemini_common.js, playwright_naver_pipeline.js
 */


const fs = require('fs');
const path = require('path');

/**
 * Naver prompt template — single source of truth.
 *
 * All naver prompt construction must go through buildNaverPrompt().
 * The template file (gemini-naver-template.txt) is the authoritative source.
 * This JS constant is the offline/error fallback only.
 *
 * Template placeholders:
 *   {{TOPIC}}      — user-supplied topic/keyword
 *   {{BLOG_ALIAS}} — blog display name (e.g. "인교블로그"), may be empty
 */

const DEFAULT_NAVER_TEMPLATE_FILE = path.join(__dirname, 'prompts', 'gemini-naver-template.txt');

// ── Template file helpers ─────────────────────────────────────────────────────

function resolveNaverPromptTemplatePath() {
  const override = String(process.env.JABLY_NAVER_PROMPT_FILE || '').trim();
  return override ? path.resolve(override) : DEFAULT_NAVER_TEMPLATE_FILE;
}

function readLocalNaverPromptTemplateFile() {
  const filePath = resolveNaverPromptTemplatePath();
  if (!fs.existsSync(filePath)) {
    throw new Error(`[NaverPrompt] 필수 프롬프트 파일이 없습니다: ${filePath}`);
  }
  const text = fs.readFileSync(filePath, 'utf8');
  // 헤더 블록(=== 로 시작하는 줄부터 === 로 끝나는 줄까지) 제거
  const body = text.replace(/^={10,}[\s\S]*?={10,}\r?\n?/, '').trim();
  if (!body) {
    throw new Error(`[NaverPrompt] 프롬프트 파일이 비어있습니다: ${filePath}`);
  }
  return body;
}

/**
 * Returns the raw template string (with {{TOPIC}} and {{BLOG_ALIAS}} placeholders).
 * Throws an error if the .txt file is missing.
 */
function getNaverPromptTemplate() {
  return readLocalNaverPromptTemplateFile();
}
// ── Main builder — single entry point for all naver prompt construction ───────

/**
 * Build the final Gemini prompt for a Naver blog post.
 *
 * @param {string} topic      User-supplied topic / keyword (required)
 * @param {string} [blogAlias] Blog display name shown in the intro greeting (optional)
 * @returns {string}          Complete prompt ready to send to Gemini
 */
function buildNaverPrompt(topic, blogAlias) {
  const template = getNaverPromptTemplate();
  const safeTopic     = String(topic      ?? '').trim();
  const safeBlogAlias = String(blogAlias  ?? '').trim();

  return template
    .replace(/\{\{TOPIC\}\}/g,      safeTopic)
    .replace(/\{\{BLOG_ALIAS\}\}/g, safeBlogAlias);
}

// ── Legacy compatibility shims ────────────────────────────────────────────────
// These keep existing call-sites in gemini_common.js / prompt_cache.js working
// without modification.

/** Full local template (file) used when server fetch is disabled or unavailable. */
function getGeminiNaverLocalPromptTemplate() {
  return getNaverPromptTemplate();
}

/** Short placeholder when server fetch was attempted but failed. */
function getGeminiNaverServerFallbackTemplate() {
  return getNaverPromptTemplate();
}

/**
 * Appends a topic string to a naver prompt base.
 * Legacy shim — new code should use buildNaverPrompt() directly.
 */
function appendTopicToNaverPromptBase(base, topicLine) {
  const tail = String(topicLine ?? '').replace(/\s+/g, ' ').trim();
  if (!tail) {
    return String(base ?? '').trim();
  }
  // If the base already contains the {{TOPIC}} placeholder, replace it.
  const baseStr = String(base ?? '').trim();
  if (baseStr.includes('{{TOPIC}}')) {
    return baseStr.replace(/\{\{TOPIC\}\}/g, tail).replace(/\{\{BLOG_ALIAS\}\}/g, '');
  }
  // Otherwise append (old-style template without placeholders).
  return `${baseStr} ${tail}`;
}

module.exports = {
  // ── Primary API ──
  buildNaverPrompt,
  getNaverPromptTemplate,

  // ── Legacy shims ──
  DEFAULT_NAVER_TEMPLATE_FILE,
  resolveNaverPromptTemplatePath,
  readLocalNaverPromptTemplateFile,
  getGeminiNaverLocalPromptTemplate,
  getGeminiNaverServerFallbackTemplate,
  appendTopicToNaverPromptBase,
};
