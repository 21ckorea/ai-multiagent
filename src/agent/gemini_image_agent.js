'use strict';

const geminiImageHelper = require('../lib/gemini_image');
const util = require('util');
const execFile = util.promisify(require('child_process').execFile);
const path = require('path');
const fs = require('fs');

/**
 * Gemini Image Agent
 * 
 * @param {string} prompt - JSON format instructions or string.
 * @param {object} options - Options object.
 * @returns {Promise<string>}
 */
async function execute(prompt, options) {
  options?.log?.('Gemini 이미지 생성 에이전트 실행...');
  
  let params = {};
  try {
    const promptToParse = options?.rawPrompt || prompt;
    const jsonMatch = promptToParse.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      params = JSON.parse(jsonMatch[0]);
      
      if (options?.context) {
        for (const [key, val] of Object.entries(params)) {
          if (typeof val === 'string') {
            const match = val.match(/^\{\{(.+)\}\}$/);
            if (match && options.context[match[1]]) {
              params[key] = options.context[match[1]];
            }
          }
        }
      }
    }
  } catch (e) {
    params = {};
  }

  let parsedText = params.text || '';
  let style = params.style || '';
  let parsedObj = null;
  let cleanText = '';

  if (typeof parsedText === 'string') {
    cleanText = parsedText.trim();
    if (cleanText.startsWith('Gemini의 응답')) {
      cleanText = cleanText.replace(/^Gemini의 응답\s*/, '').trim();
    }
    if (cleanText.startsWith('```')) {
      cleanText = cleanText.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '').trim();
    }
    try {
      parsedObj = JSON.parse(cleanText);
    } catch(e) {}
  }

  const prompts = [];
  
  if (parsedObj) {
    if (parsedObj.title) {
      prompts.push({ type: 'thumbnail', text: `주제: ${parsedObj.title}\n스타일: ${style}` });
    }
    if (parsedObj.blocks && Array.isArray(parsedObj.blocks)) {
      const { buildNaverPastePayloadFromJson } = require('../lib/naver_common');
      const payload = buildNaverPastePayloadFromJson(cleanText);
      const { buildNaverImagePlaceholders } = require('../lib/naver_image');
      const placeholders = buildNaverImagePlaceholders(payload.blocks);
      for (const ph of placeholders) {
        if (ph.promptInner) {
          prompts.push({ type: 'imgplace', text: `주제: ${ph.promptInner}\n스타일: ${style}`, marker: ph.marker });
        }
      }
    }
  } else {
    // JSON 파싱에 실패했더라도 원문 HTML이 전달되었을 경우를 대비해 플레이스홀더를 직접 추출합니다.
    const { extractImagePlaceholders } = require('../lib/gemini_validate');
    const { extractFirstH1PlainTextFromHtml } = require('../lib/tistory_publish_harvest');
    const placeholders = extractImagePlaceholders(cleanText);
    
    if (placeholders && placeholders.length > 0) {
      let h1 = (typeof params.title === 'string' && params.title.trim()) ? params.title.trim() : '';
      if (!h1) {
        h1 = extractFirstH1PlainTextFromHtml(cleanText);
      }
      if (h1) {
        h1 = h1.replace(/^\[?\d{1,2}\]?(?![\.\,]\d)[\s\.\,\-\_]+\s*/, '').trim();
      }
      prompts.push({ type: 'thumbnail', text: `주제: ${h1 || '블로그 대표 이미지'}\n스타일: ${style}` });
      for (const ph of placeholders) {
        prompts.push({
          type: 'imgplace',
          text: `주제: ${ph.prompt}\n스타일: ${style}`,
          marker: ph.fullPlaceholderLine || ph.prompt
        });
      }
    } else if (parsedText && style) {
      prompts.push({ type: 'single', text: `주제: ${parsedText}\n스타일: ${style}` });
    } else {
      prompts.push({ type: 'single', text: parsedText || style || '' });
    }
  }

  if (prompts.length === 0 || !prompts[0].text) {
    return '[ERROR] 생성할 이미지의 프롬프트(text 또는 style)가 없습니다.';
  }

  try {
    options?.log?.(`본문에서 ${prompts.length}개의 이미지 프롬프트 추출 완료. 생성을 시작합니다...`);
    
    const tempDir = path.resolve(process.cwd(), 'temp_images');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    
    const geminiAgent = require('./gemini_agent');
    const { context, page } = await geminiAgent.getOrCreateContext(options.headless !== false);

    const mockLogger = {
      info: (m) => options?.log?.(m),
      error: (m) => options?.log?.(`[ERROR] ${m}`),
      result: (r, m) => options?.log?.(`[RESULT] ${r}: ${m}`)
    };

    const results = [];
    for (let i = 0; i < prompts.length; i++) {
      const p = prompts[i];
      options?.log?.(`[${i+1}/${prompts.length}] 이미지 생성 중... (${p.type})`);
      
      // 새 채팅으로 시작하여 이전 이미지가 덮어씌워지는 현상 방지
      try {
        await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded' });
        // 고정 3초 대신: editor 셀렉터가 실제로 나타날 때까지 대기 (최대 30초)
        try {
          await page.waitForSelector(
            'div.ql-editor[role="textbox"], div.ql-editor[contenteditable="true"], rich-textarea, [contenteditable="true"][class*="input"]',
            { timeout: 30000 }
          );
        } catch {
          // selector 못 찾아도 5초 대기 후 계속 시도
          await new Promise(res => setTimeout(res, 5000));
        }
      } catch (e) {
        options?.log?.(`[WARN] 새 채팅 페이지 이동 중 오류: ${e.message}`);
      }

      // skipSpaWait:true — 이미 page.goto로 올바른 URL에 있으므로
      // waitForGeminiSpaReady의 20초 폴링을 건너뜀
      let imageResult = await geminiImageHelper.runGeminiImageGeneration(
        page, context, p.text, mockLogger, { skipSpaWait: true }
      );

      // spa_not_ready인 경우 10초 추가 대기 후 1회 재시도
      if (!imageResult.ok && imageResult.reason === 'spa_not_ready') {
        options?.log?.(`[WARN] ${i+1}번째 SPA 미준비 — 10초 대기 후 재시도...`);
        await new Promise(res => setTimeout(res, 10000));
        imageResult = await geminiImageHelper.runGeminiImageGeneration(
          page, context, p.text, mockLogger, { skipSpaWait: false }
        );
      }
      
      if (imageResult.ok && imageResult.dataUrl) {
        const outFilename = `gemini_img_${Date.now()}_${i}.png`;
        const outPath = path.resolve(tempDir, outFilename);
        const base64Data = imageResult.dataUrl.replace(/^data:image\/\w+;base64,/, '');
        fs.writeFileSync(outPath, base64Data, 'base64');
        results.push({
          type: p.type,
          prompt: p.text,
          marker: p.marker || null,
          localPath: outPath
        });
      } else {
        options?.log?.(`[ERROR] ${i+1}번째 이미지 생성 실패: ${imageResult.reason}`);
      }
      // 이미지 간 대기: 2초 → 5초 (브라우저 정리 시간 확보)
      await new Promise(res => setTimeout(res, 5000));
    }

    if (results.length > 0) {
      options?.log?.(`총 ${results.length}개의 이미지 저장 완료!`);
      return JSON.stringify({
        success: true,
        images: results,
        message: `${results.length}개의 이미지 생성 완료`,
      });
    } else {
      return `[ERROR] 모든 이미지 생성에 실패했습니다.`;
    }
  } catch (err) {
    return `[ERROR] 이미지 생성 실패: ${err.message}`;
  } finally {
    try {
      const geminiAgent = require('./gemini_agent');
      await geminiAgent.closeAgent();
    } catch (e) {
      /* ignore */
    }
  }
}

module.exports = {
  execute,
};
