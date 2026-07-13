'use strict';

/**
 * @file playwright_naver_publish.js
 * @description 네이버 블로그 글 발행 자동화 (Playwright)
 * @purpose  네이버 에디터에 본문이 삽입된 후 발행 버튼 클릭, 공개 설정,
 *           카테고리 선택 등 최종 발행 단계를 자동화.
 * @exports  publishNaverPost
 * @seeAlso  playwright_naver_pipeline.js, naver_editor.js
 */


const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const {
  POST_SUCCESS_HOLD_MS,
  EXIT,
  RESULT,
  createLogger,
  sleep,
  CHROME_STEALTH_ARGS,
  PLAYWRIGHT_STEALTH_IGNORE_DEFAULT_ARGS,
  applyPlaywrightStealthInitScript,
} = require('./common');
const { extendBridgeProtocol } = require('./bridge_protocol');
const {
  normalizeNaverBlogId,
  buildNaverBlogWriteUrl,
  isNaverLoginFailureUrl,
  isNaverBlogWriteSuccessUrl,
  buildNaverPastePayloadFromGeminiContent,
  buildNaverPastePayloadFromJson,
  readTextFile,
  logNaverParsedSections,
} = require('./naver_common');
const { pasteNaverTitleAndBody, naverPublishPostPublic, naverOpenPublishAndEnterTags } = require('./naver_editor');

const ENGINE = 'Playwright';
const PAGE_LOAD_TIMEOUT_MS = 60000;

function parseArgs(argv = process.argv.slice(2)) {
  const args = require('minimist')(argv, {
    string: ['blog-id', 'blogId', 'xml-file', 'xmlFile', 'html-file', 'htmlFile', 'content-file', 'contentFile', 'image-path', 'imagePath', 'visibility', 'category', 'naver-id', 'naverId'],
    boolean: ['no-publish', 'noPublish', 'help', 'h', 'with-images', 'withImages'],
    alias: {
      blogId: 'blog-id',
      xmlFile: 'xml-file',
      htmlFile: 'html-file',
      contentFile: 'content-file',
      noPublish: 'no-publish',
      imagePath: 'image-path',
      h: 'help',
      withImages: 'with-images',
      naverId: 'naver-id',
      naverId: 'naver-id',
    },
  });

  return {
    blogId: args['blog-id'] || args.blogId || '',
    xmlFile: args['xml-file'] || args.xmlFile || '',
    htmlFile: args['html-file'] || args.htmlFile || '',
    contentFile: args['content-file'] || args.contentFile || '',
    imagePath: (args['image-path'] || args.imagePath) ? require('path').resolve(process.cwd(), args['image-path'] || args.imagePath) : '',
    visibility: args.visibility || '2',
    noPublish: args['no-publish'] === true || args.noPublish === true,
    help: args.help === true || args.h === true,
    withImages: args['with-images'] === true || args.withImages === true,
    category: args.category || '',
    naverId: args['naver-id'] || args.naverId || '',
    images: args.images || [],
  };
}

function printHelp() {
  console.log(`Naver compose + private publish (Track 9-P1)

Usage:
  node automation/playwright_naver_publish.js --blog-id <id> --xml-file <path> [options]

Required:
  --blog-id         Naver blog id or blog URL

Content (one of):
  --xml-file        Gemini Naver XML/HTML file (<final_title> tags)
  --html-file       Alias for --xml-file
  --content-file    Alias for --xml-file

Options:
  --no-publish      Fill editor only; skip private publish clicks
  --help, -h        Show this help

Example:
  node automation/playwright_naver_publish.js \\
    --blog-id myblog \\
    --xml-file build/gemini-naver-draft.xml
`);
}

async function tryDismissDraftPopup(page) {
  try {
    const clicked = await page.evaluate(() => {
      const popup =
        document.querySelector('.se-popup-container.__se-pop-layer') ||
        document.querySelector('.se-popup-container');
      if (!popup) return false;
      const titleEl = popup.querySelector('.se-popup-title');
      const titleText = (titleEl?.textContent || '').replace(/\s+/g, ' ').trim();
      if (!/작성\s*중인\s*글이\s*있습니다/.test(titleText)) return false;
      const btn =
        popup.querySelector('button.se-popup-button-cancel') ||
        popup.querySelector('.se-popup-button-cancel');
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (clicked) await sleep(400);
  } catch {
    /* ignore */
  }
}

function resolveContentPath(args) {
  const candidate = args.xmlFile || args.htmlFile || args.contentFile;
  return candidate ? path.resolve(candidate) : '';
}

function logNaverPublishMarker(logger, payload) {
  logger.info(`[NAVER] [PUBLISH] ${JSON.stringify(payload)}`);
}

async function run(options = {}) {
  const logger = extendBridgeProtocol(createLogger(ENGINE));
  const args = { ...parseArgs(), ...options };
  const blogId = normalizeNaverBlogId(args.blogId);
  const writeUrl = buildNaverBlogWriteUrl(blogId);
  const contentPath = resolveContentPath(args);

  if (args.help) {
    printHelp();
    return EXIT.SUCCESS;
  }

  if (!blogId || !writeUrl) {
    logNaverPublishMarker(logger, { ok: false, reason: 'missing_blog_id' });
    logger.result(RESULT.FAILED, 'missing_blog_id');
    return EXIT.FAILED;
  }

  if (!contentPath || !fs.existsSync(contentPath)) {
    logNaverPublishMarker(logger, { ok: false, reason: 'missing_content_file', path: contentPath });
    logger.result(RESULT.FAILED, 'missing_content_file');
    return EXIT.FAILED;
  }

  const rawContent = readTextFile(contentPath);

  // JSON 형식(Gemini naver JSON prompt 응답)과 XML 형식(레거시) 모두 지원.
  // HTML 태그가 포함되어 있을 수 있으므로 태그를 제거하고 디코딩하여 순수 JSON 텍스트 추출 시도.
  const cleanContentForJson = rawContent
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

  let pastePayload;
  let parsedFormat = 'xml';
  try {
    const trimmedForJson = cleanContentForJson
      .replace(/^\uFEFF/, '')
      .replace(/^```[a-zA-Z]*\s*/, '')
      .replace(/\s*```$/, '')
      .trim();
    const jsonObj = JSON.parse(trimmedForJson);
    if (jsonObj && typeof jsonObj === 'object' && (typeof jsonObj.title === 'string' || Array.isArray(jsonObj.blocks))) {
      pastePayload = buildNaverPastePayloadFromJson(cleanContentForJson);
      parsedFormat = 'json';
    } else {
      pastePayload = buildNaverPastePayloadFromGeminiContent(rawContent);
    }
  } catch {
    pastePayload = buildNaverPastePayloadFromGeminiContent(rawContent);
  }
  logNaverParsedSections(logger, pastePayload.parsed);

  if (!pastePayload.title.trim() && !pastePayload.body.trim() && !(pastePayload.blocks && pastePayload.blocks.length)) {
    logNaverPublishMarker(logger, { ok: false, reason: 'empty_body_after_parse' });
    logger.result(RESULT.FAILED, 'empty_body_after_parse');
    return EXIT.FAILED;
  }

  logNaverPublishMarker(logger, {
    ok: true,
    status: 'parse_ok',
    blogId,
    parsedFormat,
    looksXml: pastePayload.looksXml,
    titleLen: pastePayload.title.length,
    bodyLen: pastePayload.body.length,
    blocksCount: (pastePayload.blocks || []).length,
    tagsCount: (pastePayload.tags || []).length,
    contentFile: contentPath,
  });

  let context;
  try {
    const naverIdSuffix = args.naverId ? '-' + args.naverId : '';
    const userDataDir = path.resolve(process.cwd(), 'profiles/playwright-naver-profile' + naverIdSuffix);
    fs.mkdirSync(userDataDir, { recursive: true });
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: args.headless === true,
      channel: 'chrome',
      args: CHROME_STEALTH_ARGS,
      ignoreDefaultArgs: PLAYWRIGHT_STEALTH_IGNORE_DEFAULT_ARGS,
    });
    await applyPlaywrightStealthInitScript(context);
    const page = context.pages()[0] || await context.newPage();

    logger.info(`Navigating to ${writeUrl}`);
    await page.goto(writeUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_TIMEOUT_MS });

    const startUrl = page.url();
    if (isNaverLoginFailureUrl(startUrl)) {
      logNaverPublishMarker(logger, {
        ok: false,
        if (isNaverLoginFailureUrl(url)) {
          logNaverPublishMarker(logger, { ok: false, reason: 'login_required', url });
          logger.result(RESULT.FAILED, 'login_required');
          return EXIT.FAILED;
        }
        if (isNaverBlogWriteSuccessUrl(url, blogId)) {
          ready = true;
          break;
        }
        await sleep(500);
      }
      if (!ready) {
        logNaverPublishMarker(logger, { ok: false, reason: 'editor_url_timeout' });
        logger.result(RESULT.FAILED, 'editor_url_timeout');
        return EXIT.FAILED;
      }
    }

    await tryDismissDraftPopup(page);

    const filled = await pasteNaverTitleAndBody(
      page,
      pastePayload.title,
      pastePayload.body,
      logger,
      {
        imagePath: args.imagePath,
        blocks: pastePayload.blocks || null,
        intro: pastePayload.intro || '',
        thumbnail: args.withImages || (args.images && Array.isArray(args.images) && args.images.some(img => img.type === 'thumbnail')),
      }
    );
    if (!filled) {
      logNaverPublishMarker(logger, { ok: false, reason: 'editor_fill_failed' });
      logger.result(RESULT.FAILED, 'editor_fill_failed');
      return EXIT.FAILED;
    }

    logNaverPublishMarker(logger, {
      ok: true,
      status: 'editor_filled',
      bodyLen: pastePayload.body.length,
    });

    if (args.withImages) {
      logger.info('[NAVER] starting image generation flow for body images...');
      try {
        const { runGeminiSessionFromProfile, PROFILE_DIR } = require('./playwright_gemini_test');
        const { DEFAULT_GEMINI_URL } = require('./gemini_common');
        const { runNaverImageQueue } = require('./naver_image');

        logger.info('[NAVER] launching Gemini context for image queue...');
        const geminiSession = await runGeminiSessionFromProfile({
          url: DEFAULT_GEMINI_URL,
          profileDir: PROFILE_DIR,
          logger,
        });

        if (geminiSession) {
          logger.info('[NAVER] running image queue...');
          await runNaverImageQueue({
            geminiSession,
            naverPage: page,
            blocks: pastePayload.blocks || [],
            title: pastePayload.title,
            thumbnail: false,
            logger,
            geminiAppUrl: 'https://gemini.google.com/app',
          });
          await geminiSession.context.close().catch(() => {});
        } else {
          logger.warn('[NAVER] could not launch Gemini session for images');
        }
      } catch (imgError) {
        logger.error(`[NAVER] image flow error: ${imgError.message}`);
      }
    } else if (args.images && Array.isArray(args.images) && args.images.length > 0) {
      logger.info(`[NAVER] pasting ${args.images.length} images directly from local paths...`);
      try {
        const { pasteImageIntoNaverPlaceholder } = require('./naver_image');
        const { resolveEditorFrame } = require('./naver_editor');
        const fs = require('fs');
        const editorFrame = await resolveEditorFrame(page, logger);
        
        let thumbImage = args.images.find(img => img.type === 'thumbnail') || args.images[0];
        let bodyImages = args.images.filter(img => img !== thumbImage);
        
        if (thumbImage && thumbImage.localPath && fs.existsSync(thumbImage.localPath)) {
          logger.info(`[NAVER] 썸네일 이미지 삽입 시작`);
          const base64 = fs.readFileSync(thumbImage.localPath, 'base64');
          const dataUrl = 'data:image/png;base64,' + base64;
          await pasteImageIntoNaverPlaceholder(page, editorFrame, dataUrl, '썸네일 삽입 공간', logger);
        }
        
        for (let i = 0; i < bodyImages.length; i++) {
          const bImg = bodyImages[i];
          if (bImg.localPath && fs.existsSync(bImg.localPath) && bImg.marker) {
            logger.info(`[NAVER] 본문 이미지 삽입 중... (${i+1}/${bodyImages.length})`);
            const base64 = fs.readFileSync(bImg.localPath, 'base64');
            const dataUrl = 'data:image/png;base64,' + base64;
            await pasteImageIntoNaverPlaceholder(page, editorFrame, dataUrl, bImg.marker, logger);
          }
        }
      } catch (imgError) {
        logger.error(`[NAVER] direct image paste error: ${imgError.message}`);
      }
    }

    if (args.noPublish) {
      logger.result(RESULT.SUCCESS, 'Naver editor filled (no publish)');
      await sleep(POST_SUCCESS_HOLD_MS);
      return EXIT.SUCCESS;
    }

    const tags = Array.isArray(pastePayload.tags) ? pastePayload.tags : [];
    let pR;
    if (tags.length || args.category) {
      logger.info(`[NAVER] publishing with ${tags.length} tag(s) and category="${args.category}" via naverOpenPublishAndEnterTags`);
      const tagR = await naverOpenPublishAndEnterTags(page, {
        tags,
        visibility: args.visibility,
        finalPublish: true,
        categoryElementId: args.category || '',
      }, logger);
      pR = { ok: tagR.ok, detail: tagR.ok ? '' : (tagR.reason || 'tag_publish_failed') };
    } else {
      pR = await naverPublishPostPublic(page, { visibility: args.visibility, logger });
    }
    if (!pR.ok) {
      logger.error(`[NAVER] publish flow failed: ${pR.detail || pR.errorCode}`);
      logNaverPublishMarker(logger, { ok: false, reason: 'public_publish_failed' });
      logger.result(RESULT.FAILED, 'public_publish_failed');
      return EXIT.FAILED;
    }

    logNaverPublishMarker(logger, { ok: true, status: 'public_published' });
    logger.result(RESULT.SUCCESS, 'Naver public publish completed');
    await sleep(POST_SUCCESS_HOLD_MS);
    return EXIT.SUCCESS;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logNaverPublishMarker(logger, { ok: false, reason: 'browser_error', message: detail });
    logger.error(detail);
    logger.result(RESULT.FAILED, 'browser_error');
    return EXIT.FAILED;
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

if (require.main === module) {
  const args = parseArgs();
  if (args.help) {
    printHelp();
    process.exitCode = EXIT.SUCCESS;
  } else {
    run(args)
      .then((code) => {
        process.exitCode = code;
      })
      .catch((error) => {
        const logger = createLogger(ENGINE);
        logger.error(error instanceof Error ? error.message : String(error));
        logger.result(RESULT.FAILED, 'Unhandled script error.');
        process.exitCode = EXIT.FAILED;
      });
  }
}

module.exports = {
  parseArgs,
  printHelp,
  run,
  buildNaverPastePayloadFromGeminiContent,
};
