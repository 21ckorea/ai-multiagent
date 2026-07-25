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
      params = JSON.parse(jsonMatch[0]);
      
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
    params = {};
  }

  let title = params.title || '새 블로그 포스트';
  try {
    const parsedTitle = JSON.parse(title);
    if (parsedTitle && parsedTitle.title) {
      title = parsedTitle.title;
    }
  } catch (e) {
    // 일반 텍스트면 그냥 사용
  }

  const content = params.content || ''; // HTML or markdown
  const images = params.images || []; // Array of local paths
  const tags = params.tags || []; // Array of tags

  if (!content) {
    return '[ERROR] 작성할 본문(content)이 없습니다.';
  }

  const fs = require('fs');
  const path = require('path');
  const tempDir = path.resolve(process.cwd(), 'temp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  
  const tempFile = path.resolve(tempDir, `tistory_post_${Date.now()}.json`);
  const postData = {
    title: title,
    body: content,
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
      if (parsedObj.content) postData.body = parsedObj.content;
      if (parsedObj.body) postData.body = parsedObj.body;
      if (parsedObj.tags) postData.tags = parsedObj.tags;
    }
  } catch(e) {}

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
        visibility: '0', // 0: 비공개(초안) 우선
        headless: true, // 기본으로 백그라운드에서 조용히 실행
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
