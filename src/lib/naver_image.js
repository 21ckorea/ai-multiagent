'use strict';

/**
 * @file naver_image.js
 * @description 네이버 블로그 이미지 업로드 자동화
 * @purpose  Gemini가 생성한 이미지를 네이버 블로그 에디터의 이미지 삽입 공간에
 *           클립보드 붙여넣기 방식으로 업로드하여 imgplace를 실제 이미지로 교체.
 * @exports  uploadNaverImage, insertImageAtPlaceholder
 * @seeAlso  naver_editor.js, naver_common.js
 */


// Naver image flow — independent from Tistory.
//
// For every `[이미지가 들어갈 공간 N]` placeholder in the body, build a Gemini
// image prompt from the paragraph/summary that FOLLOWS the placeholder, generate
// the image in the (separate) Gemini session, then paste it into the Naver
// SmartEditor at that placeholder via the OS clipboard (Ctrl+V), deleting the
// placeholder text. The article text itself is filled elsewhere (PASS1-3).

const { sleep } = require('./common');
const { buildGeminiImagePrompt, runGeminiImageGenerationWithRestarts } = require('./gemini_image');
const { reloadGeminiPageForRetry } = require('./gemini_compose');
const { resolveEditorFrame } = require('./naver_editor');

const isMac = process.platform === 'darwin';

async function writeImageToClipboardInPage(page, dataUrl, logger) {
  try {
    await page
      .context()
      .grantPermissions(['clipboard-read', 'clipboard-write'])
      .catch(() => {});
  } catch {
    /* ignore */
  }
  await page.bringToFront().catch(() => {});
  const wrote = await page.evaluate(async (durl) => {
    try {
      const res = await fetch(durl);
      const blob = await res.blob();
      const type = blob.type || 'image/png';
      // eslint-disable-next-line no-undef
      await navigator.clipboard.write([new ClipboardItem({ [type]: blob })]);
      return { ok: true };
    } catch (e) {
      return { ok: false, err: String((e && e.message) || e) };
    }
  }, dataUrl);
  if (!wrote?.ok) {
    logger?.warn?.(`[CLIPBOARD] write failed: ${wrote?.err}`);
  }
  return wrote?.ok === true;
}

// Build the per-placeholder work list from the parsed blocks. Each imgplace's
// prompt content = the first paragraph/summary AFTER it (stop at the next
// imgplace so we never borrow a far-away section's text).
function buildNaverImagePlaceholders(blocks) {
  const list = Array.isArray(blocks) ? blocks : [];
  const placeholders = [];
  for (let i = 0; i < list.length; i += 1) {
    const b = list[i];
    if (!b || b.type !== 'imgplace') continue;
    // Primary: the LLM-provided image subject carried on the imgplace block.
    let inner = typeof b.imagePrompt === 'string' ? b.imagePrompt.trim() : '';
    // Fallback (old format / empty subject): first paragraph/summary after it.
    if (!inner) {
      for (let j = i + 1; j < list.length; j += 1) {
        const nb = list[j];
        if (!nb) continue;
        if (nb.type === 'imgplace') break;
        if ((nb.type === 'paragraph' || nb.type === 'summary') && typeof nb.text === 'string' && nb.text.trim()) {
          inner = nb.text.trim();
          break;
        }
      }
    }
    placeholders.push({
      index: placeholders.length + 1,
      marker: typeof b.text === 'string' ? b.text : '',
      promptInner: inner,
    });
  }
  return placeholders;
}

// Paste one image (base64 dataUrl) into the Naver SmartEditor where `marker`
// text currently sits: write the image to the OS clipboard, triple-click-select
// the marker line, delete it, then Ctrl+V (SmartEditor uploads + inserts a real
// image component).
async function pasteImageIntoNaverPlaceholder(naverPage, editorFrame, dataUrl, marker, logger) {
  // 1) Locate the marker paragraph first so we can focus it.
  const handle = await editorFrame.evaluateHandle((m) => {
    const n = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const w = n(m);
    const paras = Array.from(document.querySelectorAll('p.se-text-paragraph')).filter(
      (p) => !p.closest('.se-documentTitle') && !p.closest('.se-section-quotation'),
    );
    for (const p of paras) {
      if (n(p.textContent) === w) {
        // Return the deepest span containing the text to avoid clicking block padding
        return p.querySelector('span.__se-node') || p;
      }
    }
    for (const p of paras) {
      if (n(p.textContent).indexOf('이미지 삽입공간') === 0) {
        return p.querySelector('span.__se-node') || p;
      }
    }
    return null;
  }, marker);
  const el = handle && handle.asElement ? handle.asElement() : null;
  if (!el) {
    let samples = [];
    try {
      samples = await editorFrame.evaluate(() => {
        const n = (s) => (s || '').replace(/\s+/g, ' ').trim();
        return Array.from(document.querySelectorAll('p.se-text-paragraph'))
          .filter((p) => !p.closest('.se-documentTitle'))
          .map((p) => n(p.textContent).slice(0, 28))
          .slice(0, 22);
      });
    } catch {
      /* ignore */
    }
    logger?.info?.(
      `[NAVER][IMG] marker NOT found want="${String(marker).slice(0, 40)}" paras=${JSON.stringify(samples)}`,
    );
    try {
      await handle?.dispose?.();
    } catch {
      /* ignore */
    }
    return { ok: false, reason: 'marker_not_found' };
  }

  const matchedText = await editorFrame.evaluate(
    (p) => (p.textContent || '').replace(/\s+/g, ' ').trim(),
    el,
  );
  logger?.info?.(`[NAVER][IMG] marker found "${matchedText.slice(0, 48)}"`);

  // 2) Focus the editor by clicking the marker element.
  await naverPage.bringToFront().catch(() => {});
  try {
    await el.scrollIntoViewIfNeeded().catch(() => {});
    await el.click().catch(() => {});
    await sleep(250);
  } catch (e) {
    logger?.warn?.(`[NAVER][IMG] failed to click/focus marker element: ${e.message}`);
  }

  // 3) Put the image on the clipboard (now safe because the document is focused).
  try {
    await naverPage
      .context()
      .grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://blog.naver.com' })
      .catch(() => {});
  } catch {
    /* ignore */
  }

  const wrote = await naverPage.evaluate(async (durl) => {
    try {
      const res = await fetch(durl);
      const blob = await res.blob();
      const type = blob.type || 'image/png';
      // eslint-disable-next-line no-undef
      await navigator.clipboard.write([new ClipboardItem({ [type]: blob })]);
      return { ok: true, type, size: blob.size };
    } catch (e) {
      return { ok: false, err: String((e && e.message) || e) };
    }
  }, dataUrl);
  logger?.info?.(
    `[NAVER][IMG] clipboard write ok=${wrote?.ok} ${wrote?.ok ? `type=${wrote.type} size=${wrote.size}` : `err=${wrote?.err}`}`,
  );
  if (!wrote?.ok) {
    try {
      await handle?.dispose?.();
    } catch {
      /* ignore */
    }
    return { ok: false, reason: 'clipboard_write_failed' };
  }

  const countImages = () =>
    editorFrame
      .evaluate(() => document.querySelectorAll('.se-component.se-image, .se-module-image').length)
      .catch(() => -1);
  const imgBefore = await countImages();

  let cdp;
  try {
    cdp = await naverPage.context().newCDPSession(naverPage);
    await cdp.send('Input.enable', {}).catch(() => {});

    await el.scrollIntoViewIfNeeded().catch(() => {});
    // Let any image inserted ABOVE this marker finish loading so the layout
    // settles and the bounding box is accurate (stale coords were missing the
    // marker → editor not focused → Ctrl+V did nothing).
    await sleep(450);
    const box = await el.boundingBox();
    if (!box) {
      logger?.info?.('[NAVER][IMG] no bounding box for marker');
      return { ok: false, reason: 'no_box' };
    }
    // Click near the FIRST line (top-left). The center of a tall multi-line
    // marker can land between lines and miss, leaving the editor unfocused.
    const cx = box.x + 12;
    const cy = box.y + Math.min(12, box.height / 2);
    logger?.info?.(
      `[NAVER][IMG] marker box top(${Math.round(cx)},${Math.round(cy)}) h=${Math.round(box.height)} imgBefore=${imgBefore}`,
    );

    // ── JS Range 선택 (macOS/Windows 모두 안정적으로 동작) ─────────────────
    // CDP triple-click은 Windows의 iframe 내 selection이 window.getSelection()에
    // 반영되지 않아 selLen=0 → Delete가 마커가 아닌 다음 줄을 삭제하는 문제 발생.
    // editorFrame.evaluate()로 직접 Range를 만들어 마커 노드를 선택한 뒤 Delete.
    const selLen = await editorFrame.evaluate((targetText) => {
      try {
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const w = norm(targetText);
        // 마커 P 요소 탐색
        let targetP = null;
        for (const p of document.querySelectorAll('p.se-text-paragraph')) {
          if (p.closest('.se-documentTitle') || p.closest('.se-section-quotation')) continue;
          if (norm(p.textContent) === w || norm(p.textContent).indexOf('이미지 삽입공간') === 0 || norm(p.textContent).indexOf('썸네일 삽입 공간') === 0) {
            targetP = p;
            break;
          }
        }
        if (!targetP) return 0;
        // Range로 P 전체 선택
        const range = document.createRange();
        range.selectNodeContents(targetP);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        // 선택 확인
        return (sel.toString() || '').replace(/\s+/g, ' ').trim().length;
      } catch (e) {
        return 0;
      }
    }, matchedText);
    logger?.info?.(`[NAVER][IMG] JS range select selLen=${selLen}`);

    // 포커스 확보를 위해 한 번 클릭 후 대기
    if (selLen === 0) {
      // 선택 실패 시 클릭으로 캐럿 이동 후 Home+Shift+End 로 줄 선택
      await naverPage.mouse.click(cx, cy);
      await sleep(150);
      await naverPage.keyboard.press('Home');
      await sleep(50);
      await naverPage.keyboard.down('Shift');
      await naverPage.keyboard.press('End');
      await naverPage.keyboard.up('Shift');
      await sleep(100);
    }

    // 선택된 마커 텍스트 삭제 (선택 → Backspace 한 번으로 충분)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 8, code: 'Backspace', key: 'Backspace' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 8, code: 'Backspace', key: 'Backspace' });
    await sleep(120);

    // Paste — SmartEditor intercepts the image paste, uploads, inserts a component.
    const pasteKey = isMac ? 'Meta+V' : 'Control+V';
    await naverPage.keyboard.press(pasteKey);
    logger?.info?.(`[NAVER][IMG] Delete + ${pasteKey} sent — waiting for image insert...`);

    // Probe = the distinctive description part of the marker. If ANY paragraph
    // still contains it (even split like "미지 삽입공간 : ..."), it's not gone.
    const desc = matchedText
      .replace(/^\s*이미지\s*삽입\s*공간\s*[:：]?\s*/, '')
      .replace(/^\s*썸네일\s*삽입\s*공간\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();
    const probe = (desc || matchedText).replace(/\s+/g, ' ').trim().slice(0, 16);
    let probeGone = false;
    let imgNow = imgBefore;
    for (let i = 0; i < 20; i += 1) {
      await sleep(600);
      probeGone = !(await editorFrame.evaluate((pr) => {
        if (!pr) return false;
        const n = (s) => (s || '').replace(/\s+/g, ' ').trim();
        return Array.from(document.querySelectorAll('p.se-text-paragraph')).some(
          (p) => n(p.textContent).indexOf(pr) >= 0,
        );
      }, probe));
      imgNow = await countImages();
      if (probeGone && imgNow > imgBefore) break;
    }
    logger?.info?.(
      `[NAVER][IMG] after paste: probeGone=${probeGone} images ${imgBefore}->${imgNow} probe="${probe}"`,
    );
    if (probeGone && imgNow > imgBefore) {
      try {
        await editorFrame.evaluate(() => {
          const quotes = document.querySelectorAll('blockquote, .se-quote, .se-quote-text, .se-component-quotation, [class*="se-component-quotation"], [class*="se-quotation"]');
          for (const q of quotes) {
            const text = (q.textContent || '').replace(/[\s\u200B\u200b\u00a0]/g, '').trim();
            if (!text) {
              const comp = q.closest('.se-component, .se-section') || q;
              comp.remove();
            }
          }
        });
      } catch (err) {
        /* ignore */
      }
      return { ok: true };
    }
    if (imgNow > imgBefore) return { ok: false, reason: 'image_added_but_marker_remains' };
    return { ok: false, reason: 'marker_still_present' };
  } finally {
    try {
      await handle?.dispose?.();
    } catch {
      /* ignore */
    }
    try {
      await cdp?.detach?.();
    } catch {
      /* ignore */
    }
  }
}

// Prompt for the text-style square thumbnail (subject = the post title).
// Colors are FIXED so every thumbnail looks consistent: solid deep-navy
// background (#102A54) + solid white text (#FFFFFF) — highest readability.
function buildNaverThumbnailPrompt(title) {
  const subject = String(title || '').trim();
  return (
    '네이버 블로그용 정사각형(1:1 비율) 텍스트형 썸네일 이미지를 만들어줘. ' +
    '배경은 무늬·그라데이션·그림자·텍스처 없이 완전한 단색 짙은 남색(HEX #102A54) 한 가지 색으로만 꽉 채워줘. ' +
    `그 위 한가운데에 "${subject}" 라는 제목 문구를 단색 흰색(HEX #FFFFFF) 글씨로, 크고 굵은 한글로 또렷하게 넣어줘. ` +
    '가독성이 최우선이야: 글자는 잘리거나 겹치지 않게, 맞춤법과 띄어쓰기를 정확히 지켜서 써줘. ' +
    '배경은 오직 단색 한 가지 색(#102A54)만 사용하고 무늬·장식·도형·일러스트는 절대 넣지 마. ' +
    '정사각형 프레임을 꽉 채우고, 사람 얼굴·로고·워터마크·아이콘은 넣지 마.'
  );
}

// Generate one image in Gemini (with a fresh reload) and return {ok, dataUrl,...}.
async function generateNaverImage(geminiSession, prompt, queueIndex, queueTotal, logger, workflow, geminiAppUrl) {
  await geminiSession.page.bringToFront().catch(() => {});
  logger?.info?.(`[NAVER][IMG] reloading Gemini (${geminiAppUrl || 'default'}) before generation`);
  await reloadGeminiPageForRetry(geminiSession.page, 'navigate', geminiAppUrl, 'playwright', logger);
  await sleep(800);
  return runGeminiImageGenerationWithRestarts(
    geminiSession.page,
    geminiSession.context,
    prompt,
    logger,
    { queueIndex, queueTotal, workflow, geminiAppUrl },
  );
}

// Orchestrate the whole image queue: thumbnail first (if requested), then each
// imgplace image. Failures are non-fatal (logged).
async function runNaverImageQueue({
  geminiSession,
  naverPage,
  blocks,
  title,
  thumbnail,
  logger,
  workflow,
  geminiAppUrl,
  // 맛집리뷰 + 직접 이미지 첨부: keep the thumbnail but DO NOT generate body
  // images — leave the [이미지가 들어갈 공간] markers for the user to fill.
  skipPlaceholderImages = false,
}) {
  const skip = skipPlaceholderImages === true;
  const allPlaceholders = buildNaverImagePlaceholders(blocks);
  const placeholders = skip ? [] : allPlaceholders;
  const wantThumbnail = thumbnail === true && typeof title === 'string' && title.trim().length > 0;
  logger?.info?.(
    `[NAVER][IMG][ENTER] skipPlaceholderImages=${skip} bodyPlaceholders=${allPlaceholders.length} ` +
      `wantThumbnail=${wantThumbnail}`,
  );
  if (skip) {
    logger?.info?.(
      `[NAVER][IMG] SKIP body images (맛집리뷰 직접 첨부) — thumbnail only, ${allPlaceholders.length} marker(s) left in editor for manual attach`,
    );
  }
  logger?.info?.(
    `[NAVER][IMG] ${placeholders.length} image placeholder(s) to generate, thumbnail=${wantThumbnail}`,
  );

  const editorFrame = await resolveEditorFrame(naverPage, logger);
  if (!editorFrame) {
    logger?.info?.('[NAVER][IMG] editor frame NOT found');
    return { ok: false, done: 0, total: placeholders.length };
  }

  let done = 0;
  let markersRemaining = 0;

  const scanMarkers = () =>
    editorFrame.evaluate(() => {
      const n = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const out = [];
      for (const p of document.querySelectorAll('p.se-text-paragraph')) {
        if (p.closest('.se-documentTitle') || p.closest('.se-section-quotation')) {
          continue;
        }
        const text = n(p.textContent);
        if (text.indexOf('이미지 삽입공간') === 0 || text.indexOf('이미지 삽입 공간') === 0) {
          out.push({ text, element: p });
        }
      }
      return out;
    });

  try {
    if (wantThumbnail) {
      logger?.info?.(`[NAVER][IMG] thumbnail: generating for title="${title.slice(0, 40)}"`);
      let tg = null;
      try {
        tg = await generateNaverImage(
          geminiSession,
          buildNaverThumbnailPrompt(title),
          0,
          1,
          logger,
          workflow,
          geminiAppUrl,
        );
      } catch (e) {
        logger?.info?.(`[NAVER][IMG] thumbnail gen error=${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`);
      }
      if (tg?.ok && tg.dataUrl) {
        logger?.info?.(`[NAVER][IMG] thumbnail gen OK bytes=${tg.bytes}`);
        await writeImageToClipboardInPage(geminiSession.page, tg.dataUrl, logger);
        let tp = null;
        try {
          tp = await pasteImageIntoNaverPlaceholder(naverPage, editorFrame, tg.dataUrl, '썸네일 삽입 공간', logger);
        } catch (e) {
          logger?.info?.(`[NAVER][IMG] thumbnail paste error=${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`);
        }
        logger?.info?.(`[NAVER][IMG] thumbnail paste ${tp?.ok ? 'OK' : `FAIL reason=${tp?.reason || '?'}`}`);
      } else {
        logger?.info?.(`[NAVER][IMG] thumbnail gen FAIL reason=${tg?.reason || '?'}`);
      }
      await sleep(400);
    }

    for (const ph of placeholders) {
      logger?.info?.(
        `[NAVER][IMG] ${ph.index}/${placeholders.length} marker="${ph.marker}" innerChars=${ph.promptInner.length}`,
      );
      if (!ph.promptInner) {
        logger?.info?.(`[NAVER][IMG] ${ph.index} no following paragraph/summary — skip`);
        continue;
      }

      const prompt = buildGeminiImagePrompt(ph.promptInner);
      let gen = null;
      try {
        await geminiSession.page.bringToFront().catch(() => {});
        logger?.info?.(
          `[NAVER][IMG] ${ph.index} reloading Gemini (${geminiAppUrl || 'default'}) before generation`,
        );
        await reloadGeminiPageForRetry(geminiSession.page, 'navigate', geminiAppUrl, 'playwright', logger);
        await sleep(800);
        gen = await runGeminiImageGenerationWithRestarts(
          geminiSession.page,
          geminiSession.context,
          prompt,
          logger,
          { queueIndex: ph.index - 1, queueTotal: placeholders.length, workflow, geminiAppUrl },
        );
      } catch (e) {
        logger?.info?.(`[NAVER][IMG] ${ph.index} gen error=${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`);
      }
      if (!gen?.ok || !gen.dataUrl) {
        logger?.info?.(`[NAVER][IMG] ${ph.index} gen FAIL reason=${gen?.reason || '?'}`);
        continue;
      }
      logger?.info?.(`[NAVER][IMG] ${ph.index} gen OK bytes=${gen.bytes}`);
      await writeImageToClipboardInPage(geminiSession.page, gen.dataUrl, logger);

      let pasted = null;
      try {
        pasted = await pasteImageIntoNaverPlaceholder(naverPage, editorFrame, gen.dataUrl, ph.marker, logger);
      } catch (e) {
        logger?.info?.(`[NAVER][IMG] ${ph.index} paste error=${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`);
      }
      if (pasted?.ok) {
        done += 1;
        logger?.info?.(`[NAVER][IMG] ${ph.index} paste OK`);
      } else {
        logger?.info?.(`[NAVER][IMG] ${ph.index} paste FAIL reason=${pasted?.reason || '?'}`);
      }
      await sleep(400);
    }

    // VALIDATION
    const scanR = await scanMarkers();
    const leftoverMarkers = Array.isArray(scanR) ? scanR : [];
    if (!skip && leftoverMarkers.length > 0) {
      logger?.info?.(`[NAVER][IMG] validation round 1: ${leftoverMarkers.length} "이미지 삽입공간" marker(s) remaining`);
      for (const m of leftoverMarkers) {
        const markerText = m.text;
        const inner = markerText.replace(/이미지 삽입\s*공간\s*:\s*/i, '').trim();
        logger?.info?.(`[NAVER][IMG] re-processing leftover "${markerText.slice(0, 50)}"`);
        let gen = null;
        try {
          await geminiSession.page.bringToFront().catch(() => {});
          logger?.info?.(`[NAVER][IMG] reloading Gemini (${geminiAppUrl || 'default'}) before generation`);
          await reloadGeminiPageForRetry(geminiSession.page, 'navigate', geminiAppUrl, 'playwright', logger);
          await sleep(800);
          gen = await runGeminiImageGenerationWithRestarts(
            geminiSession.page,
            geminiSession.context,
            buildGeminiImagePrompt(inner),
            logger,
            { queueIndex: 0, queueTotal: 1, workflow, geminiAppUrl },
          );
        } catch (e) {
          logger?.info?.(`[NAVER][IMG] leftover gen error=${(e instanceof Error ? e.message : String(e)).slice(0, 100)}`);
        }
        if (gen?.ok && gen.dataUrl) {
          await writeImageToClipboardInPage(geminiSession.page, gen.dataUrl, logger);
          let tp = null;
          try {
            tp = await pasteImageIntoNaverPlaceholder(naverPage, editorFrame, gen.dataUrl, markerText, logger);
          } catch (e) {
            logger?.info?.(`[NAVER][IMG] leftover paste error=${(e instanceof Error ? e.message : String(e)).slice(0, 100)}`);
          }
          logger?.info?.(`[NAVER][IMG] leftover paste ${tp?.ok ? 'OK' : `FAIL reason=${tp?.reason || '?'}`}`);
        } else {
          logger?.info?.(`[NAVER][IMG] leftover gen FAIL reason=${gen?.reason || '?'}`);
        }
        await sleep(400);
      }
    }

    try {
      const remainingList = await scanMarkers();
      markersRemaining = Array.isArray(remainingList) ? remainingList.length : 0;
    } catch {
      /* ignore */
    }

    if (skip) {
      logger?.info?.(
        `[NAVER][IMG] ${markersRemaining} marker(s) intentionally left for manual attach (skip mode)`,
      );
    } else if (markersRemaining > 0) {
      logger?.info?.(`[NAVER][IMG] WARNING: ${markersRemaining} "이미지 삽입공간" marker(s) STILL remain after validation`);
    } else {
      logger?.info?.('[NAVER][IMG] validation passed — no image marker remains');
    }
  } finally {
    // 최종 클린업: 이미지 작업의 성공/실패/중지 여부와 상관없이 무조건 빈 인용구 컴포넌트 강제 제거
    try {
      const cleaned = await editorFrame.evaluate(() => {
        let removed = 0;
        const blockquotes = document.querySelectorAll('blockquote, .se-quote, .se-quote-text');
        for (const b of blockquotes) {
          const text = (b.textContent || '').replace(/[\s\u200B\u200b\u00a0]/g, '').trim();
          if (!text) {
            const comp = b.closest('.se-component, .se-section') || b;
            comp.remove();
            removed += 1;
          }
        }
        const quotes = document.querySelectorAll('.se-section-quotation, [class*="se-section-quotation"]');
        for (const q of quotes) {
          const text = (q.textContent || '').replace(/[\s\u200B\u200b\u00a0]/g, '').trim();
          if (!text) {
            q.remove();
            removed += 1;
          }
        }
        return removed;
      });
      if (cleaned > 0) {
        logger?.info?.(`[NAVER][IMG] cleaned up ${cleaned} empty quotation(s) in finally block`);
      }
    } catch (e) {
      /* ignore */
    }
  }

  logger?.info?.(`[NAVER][IMG] done ${done}/${placeholders.length}, markersRemaining=${markersRemaining}`);
  return {
    ok: skip ? true : markersRemaining === 0,
    done,
    total: placeholders.length,
    markersRemaining,
    skipped: skip,
  };
}

module.exports = {
  buildNaverImagePlaceholders,
  pasteImageIntoNaverPlaceholder,
  runNaverImageQueue,
};
