'use strict';

const tistoryPublishHelper = require('../lib/playwright_tistory_publish');

/**
 * Tistory Blog Publish Agent
 * 
 * @param {string} prompt - JSON format instructions
 * @param {object} options - Options object
 * @returns {Promise<string>}
 */
async function execute(prompt, options) {
  options?.log?.('Tistory 자동 포스팅 에이전트 실행...');
  
  let params = {};
  try {
    // rawPrompt(변환 전 원본 프롬프트)가 있으면 안전하게 파싱 후 변수 매핑
    const promptToParse = options?.rawPrompt || prompt;
    const jsonMatch = promptToParse.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      let jsonText = jsonMatch[0];
      // 주석 제거 (// 및 /* */ 형식, 단 URL 프로토콜인 http://, https:// 의 // 는 제외)
      jsonText = jsonText.replace(/(?<!:)\/\/.*$/gm, '');
      jsonText = jsonText.replace(/\/\*[\s\S]*?\*\//g, '');
      params = JSON.parse(jsonText);
      
      // params의 각 값에 대해 {{...}} 패턴이 있으면 context에서 찾아서 치환 (안전한 매핑)
      if (options?.context) {
        for (const [key, val] of Object.entries(params)) {
          if (typeof val === 'string') {
            const match = val.match(/^\{\{(.+)\}\}$/);
            if (match) {
              const varName = match[1];
              if (options.context[varName]) {
                params[key] = options.context[varName];
              }
            }
          }
        }
      }
    }
  } catch (e) {
    options?.log?.(`[WARN] JSON 파싱 실패: ${e.message}`);
    params = {};
  }

  let content = params.content || ''; // HTML or markdown
  let title = params.title || '';
  if (!title && content) {
    try {
      const { extractFirstH1PlainTextFromHtml } = require('../lib/tistory_publish_harvest');
      const extractedTitle = extractFirstH1PlainTextFromHtml(content);
      if (extractedTitle) {
        title = extractedTitle;
        options?.log?.(`[INFO] 제목 누락되어 본문에서 추출함: ${title}`);
      }
    } catch (e) {
      // ignore
    }
  }
  if (!title) {
    title = '새 블로그 포스트';
  }
  const images = params.images || []; // Array of local paths
  const tags = params.tags || []; // Array of tags

  if (!content) {
    return '[ERROR] 작성할 본문(content)이 없습니다.';
  }

  // 본문 클리닝 함수 (Gemini의 응답, HTML, ```html 등의 마크다운/대화형 프리픽스 제거)
  function sanitizeHtmlContent(html) {
    if (!html) return '';
    let cleaned = html.trim();
    const lines = cleaned.split('\n');
    const filteredLines = [];
    let htmlStarted = false;
    
    for (let line of lines) {
      const trimmedLine = line.trim();
      if (trimmedLine.startsWith('<')) {
        htmlStarted = true;
      }
      if (htmlStarted) {
        if (trimmedLine.startsWith('```')) {
          continue;
        }
        filteredLines.push(line);
      } else {
        if (
          trimmedLine.includes('Gemini의 응답') || 
          trimmedLine.toUpperCase() === 'HTML' || 
          trimmedLine.startsWith('```')
        ) {
          continue;
        }
        filteredLines.push(line);
      }
    }
    return filteredLines.join('\n').trim();
  }

  const cleanedRawContent = sanitizeHtmlContent(content);

  const fs = require('fs');
  const path = require('path');
  const WRITABLE_ROOT = process.env.APP_DATA_DIR
    ? path.resolve(process.env.APP_DATA_DIR)
    : path.resolve(__dirname, '../..');
  const tempDir = path.resolve(WRITABLE_ROOT, 'temp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  
  const tempFile = path.resolve(tempDir, `tistory_post_${Date.now()}.json`);
  const postData = {
    title: title,
    body: cleanedRawContent,
    blocks: [],
    tags: tags
  };
  
  // 만약 content 자체가 JSON 문자열이면 내부의 필드들을 추출
  try {
    let cleanContent = content.trim();
    if (cleanContent.startsWith('Gemini의 응답')) {
      cleanContent = cleanContent.replace(/^Gemini의 응답\s*/, '').trim();
    }
    if (cleanContent.startsWith('```')) {
      cleanContent = cleanContent.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '').trim();
    }
    const parsedObj = JSON.parse(cleanContent);
    if (parsedObj.title || parsedObj.blocks || parsedObj.content || parsedObj.body) {
      Object.assign(postData, parsedObj);
      if (parsedObj.title) title = parsedObj.title;
      if (parsedObj.content) postData.body = sanitizeHtmlContent(parsedObj.content);
      if (parsedObj.body) postData.body = sanitizeHtmlContent(parsedObj.body);
      if (parsedObj.tags) postData.tags = parsedObj.tags;
    }
  } catch(e) {
    // JSON 파싱에 실패한 경우 (순수 HTML 본문인 경우):
    // 제목이 본문 전체 매핑 등으로 인해 HTML을 포함하고 있다면 <h1> 태그에서 제목 추출 시도
    if (/<[a-z/][^>]*>/i.test(title)) {
      const { extractFirstH1PlainTextFromHtml } = require('../lib/tistory_publish_harvest');
      const h1Title = extractFirstH1PlainTextFromHtml(postData.body);
      if (h1Title) {
        title = h1Title;
      }
    }
  }

  // 최종 타이틀 클리닝 (대화형 헤더 제거 및 앞부분의 숫자. 공백 패턴 제거)
  if (title.startsWith('Gemini의 응답')) {
    title = title.replace(/^Gemini의 응답\s*(HTML)?\s*/i, '').trim();
  }
  title = title.replace(/^\[?\d{1,2}\]?(?![\.\,]\d)[\s\.\,\-\_]+\s*/, '').trim();
  postData.title = title;

  fs.writeFileSync(tempFile, JSON.stringify(postData, null, 2), 'utf8');

  try {
    options?.log?.('티스토리 스마트에디터 접속 중...');
    
    const blogUrl = params.blogUrl || 'YOUR_BLOG_URL';
    if (blogUrl === 'YOUR_BLOG_URL') {
      return `[ERROR] 프롬프트에 "blogUrl": "본인티스토리블로그주소" 를 추가해 주세요.`;
    }

    if (typeof tistoryPublishHelper.run === 'function') {
      let imageArray = [];
      if (images) {
        if (typeof images === 'string') {
           try {
             const parsedImgs = JSON.parse(images);
             if (parsedImgs.images && Array.isArray(parsedImgs.images)) {
               imageArray = parsedImgs.images;
             }
           } catch(e) {}
        } else if (Array.isArray(images)) {
           imageArray = images;
        } else if (images.images && Array.isArray(images.images)) {
           imageArray = images.images;
        }
      }

      const customLogger = {
        info: (msg) => options?.log?.(msg),
        error: (msg) => options?.log?.(`[ERROR] ${msg}`),
        warn: (msg) => options?.log?.(`[WARN] ${msg}`),
        result: (status, msg) => options?.log?.(`[RESULT: ${status}] ${msg}`)
      };

      const exitCode = await tistoryPublishHelper.run({
        blogUrl: blogUrl,
        kakaoId: params.kakaoId || '',
        kakaoPassword: params.kakaoPassword || '',
        contentFile: tempFile,
        images: imageArray,
        visibility: String(params.visibility !== undefined ? params.visibility : '0'),
        headless: options.headless !== false,
        logger: customLogger,
        withImages: params.withImages === true,
      });
      
      if (exitCode === 0) {
        return JSON.stringify({
          success: true,
          message: '티스토리 블로그 포스팅 발행이 완료되었습니다.',
        });
      } else {
        return `[ERROR] 티스토리 포스팅 발행 실패 (종료 코드: ${exitCode})`;
      }
    } else {
      return `[ERROR] tistoryPublishHelper.run 함수를 찾을 수 없습니다.`;
    }
  } catch (err) {
    return `[ERROR] 티스토리 포스팅 실패: ${err.message}`;
  }
}

module.exports = {
  execute,
};
