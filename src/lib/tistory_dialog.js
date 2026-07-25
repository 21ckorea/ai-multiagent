'use strict';

/**
 * @file tistory_dialog.js
 * @description 티스토리 발행 확인 다이얼로그 처리
 * @purpose  티스토리 글 발행 시 나타나는 팝업/다이얼로그(공개 설정, 발행 확인 등)를
 *           자동으로 감지하고 처리(닫기, 확인 클릭 등).
 * @exports  handleTistoryPublishDialog, closeTistoryModal
 * @seeAlso  tistory_editor_inject.js
 */


const { isDraftResumeDialogMessage } = require('./tistory_draft_resume');

const DIALOG_AUTO_DISMISS_MS = 120_000;

/**
 * Playwright dialog handler — must await accept/dismiss or navigation blocks on confirm().
 * Draft-resume prompts use Cancel (dismiss). CDP is intentionally omitted (races with Playwright).
 *
 * @param {import('playwright').Page} page
 * @param {import('playwright').BrowserContext} _context
 * @param {object} logger
 * @returns {Promise<{ dispose: () => Promise<void> }>}
 */
async function enableJsDialogAutoDismiss(page, _context, logger) {
  const session = {
    disposed: false,
    dialogHandler: null,
    timer: null,
  };

  session.dialogHandler = async (dialog) => {
    const message = String(dialog.message?.() || '');
    const snippet = message.replace(/\s+/g, ' ').trim().slice(0, 200);
    const draftResume = isDraftResumeDialogMessage(message);
    const action = draftResume ? 'dismiss' : 'accept';
    logger?.info?.(
      `[Tistory] [DIALOG] playwright auto-${action} type=${dialog.type()} draftResume=${draftResume} message=${snippet}`,
    );
    try {
      if (draftResume) {
        await dialog.dismiss();
      } else {
        await dialog.accept();
      }
      logger?.info?.(`[Tistory] [DIALOG] playwright ${action} done`);
    } catch (error) {
      logger?.info?.(
        `[Tistory] [DIALOG] playwright ${action} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  page.on('dialog', session.dialogHandler);

  session.timer = setTimeout(() => {
    disableJsDialogAutoDismiss(page, session, logger).catch(() => {});
  }, DIALOG_AUTO_DISMISS_MS);

  logger?.info?.('[Tistory] [DIALOG] auto-dismiss enabled (draft resume → Cancel)');

  return {
    dispose: () => disableJsDialogAutoDismiss(page, session, logger),
  };
}

/**
 * @param {import('playwright').Page} page
 * @param {object} session
 * @param {object} logger
 */
async function disableJsDialogAutoDismiss(page, session, logger) {
  if (!session || session.disposed) {
    return;
  }
  session.disposed = true;

  if (session.timer) {
    clearTimeout(session.timer);
    session.timer = null;
  }

  if (session.dialogHandler) {
    try {
      page.off('dialog', session.dialogHandler);
    } catch {
      /* ignore */
    }
    session.dialogHandler = null;
  }

  logger?.info?.('[Tistory] [DIALOG] auto-dismiss disabled');
}

/**
 * Disposes dialog sessions from enableJsDialogAutoDismiss before context.close().
 * @param {Array<{ dispose?: () => Promise<void> }>} sessions
 * @param {object} [logger]
 */
async function disposeDialogSessions(sessions, logger) {
  const list = Array.isArray(sessions) ? sessions.filter(Boolean) : [];
  if (list.length === 0) {
    return;
  }
  await Promise.all(
    list.map((session) =>
      session.dispose?.().catch((error) => {
        logger?.info?.(
          `[Tistory] [DIALOG] dispose failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }),
    ),
  );
}

module.exports = {
  DIALOG_AUTO_DISMISS_MS,
  enableJsDialogAutoDismiss,
  disableJsDialogAutoDismiss,
  disposeDialogSessions,
};
