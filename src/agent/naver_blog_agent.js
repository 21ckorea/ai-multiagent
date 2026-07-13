'use strict';

const naverEditorHelper = require('../lib/naver_editor');
const naverPublishHelper = require('../lib/playwright_naver_publish');

/**
 * Naver Blog Publish Agent
 * 
 * @param {string} prompt - JSON format instructions
 * @param {object} options - Options object
 * @returns {Promise<string>}
 */
async function execute(prompt, options) {
  options?.log?.('Naver 자동 포스팅 에이전트 실행...');
  
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
    // 만약 전달받은 title이 JSON 문자열이라면 (예: google_sheet_agent의 출력값 전체) 내부의 title 필드 추출
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
  
  const tempFile = path.resolve(tempDir, `naver_post_${Date.now()}.json`);
  const postData = {
    title: title,
    body: content,
    blocks: [],
    tags: tags
  };
  
  // 만약 content 자체가 JSON 문자열이면 그대로 저장
  try {
    let cleanContent = content.trim();
    if (cleanContent.startsWith('Gemini의 응답')) {
      cleanContent = cleanContent.replace(/^Gemini의 응답\s*/, '').trim();
    }
    if (cleanContent.startsWith('```')) {
      cleanContent = cleanContent.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '').trim();
    }
    const parsedObj = JSON.parse(cleanContent);
    if (parsedObj.title || parsedObj.blocks) {
      Object.assign(postData, parsedObj);
      if (parsedObj.title) title = parsedObj.title;
    }
  } catch(e) {}

  fs.writeFileSync(tempFile, JSON.stringify(postData, null, 2), 'utf8');

  try {
    // 1. 네이버 로그인 및 에디터 진입 (playwright 기반)
    options?.log?.('네이버 스마트에디터 접속 중...');
    
    // 블로그 ID 추출 (없으면 기본값 경고)
    const blogId = params.blogId || 'YOUR_BLOG_ID';
    if (blogId === 'YOUR_BLOG_ID') {
      return `[ERROR] 프롬프트에 "blogId": "본인네이버아이디" 를 추가해 주세요.`;
    }

    if (typeof naverPublishHelper.run === 'function') {
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

      const exitCode = await naverPublishHelper.run({
        blogId: blogId,
        naverId: params.naverId || '',
        contentFile: tempFile,
        images: imageArray,
        visibility: '0', // 0: 비공개(초안) 우선
        noPublish: false
      });
      
      if (exitCode === 0) {
        return JSON.stringify({
          success: true,
          message: '네이버 블로그 포스팅 발행이 완료되었습니다.',
        });
      } else {
        return `[ERROR] 네이버 포스팅 발행 실패 (종료 코드: ${exitCode})`;
      }
    } else {
      return `[ERROR] naverPublishHelper.run 함수를 찾을 수 없습니다.`;
    }
  } catch (err) {
    return `[ERROR] 네이버 포스팅 실패: ${err.message}`;
  }
}

module.exports = {
  execute,
};
