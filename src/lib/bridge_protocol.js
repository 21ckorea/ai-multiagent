'use strict';

/**
 * @file bridge_protocol.js
 * @description Electron 메인 프로세스 ↔ 자동화 스크립트 간 통신 프로토콜
 * @purpose  자동화 스크립트에서 발생하는 로그/상태를 JSON 형식으로 stdout에 출력하고,
 *           Electron 메인 프로세스(electron-main.js)가 이를 수신해 UI에 렌더링함.
 * @exports  extendBridgeProtocol, logBridgeEvent, BRIDGE_EVENTS
 * @seeAlso  electron-main.js, workflow_control.js
 */


/**
 * AutomationBridge stdout marker helpers (Track 0-P2).
 * Extends createLogger from common.js with canonical + legacy marker lines.
 */

function logWorkflowStep(logger, stepId, state, payload = {}) {
  const body = JSON.stringify({
    step: stepId,
    state,
    ...payload,
  });
  logger.info(`[WORKFLOW] ${body}`);
}

function logHtmlHandoff(logger, payload) {
  const body = JSON.stringify(payload);
  logger.info(`[HTML] ${body}`);
  logger.info(`[Gemini] [HTML] ${body}`);
}

function logErrorCode(logger, code, detail) {
  const suffix = detail ? ` — ${detail}` : '';
  logger.info(`[ERROR] ${code}${suffix}`);
  logger.info(`[Gemini] [ERROR] ${code}${suffix}`);
}

function logTistoryCategories(logger, items) {
  const body = JSON.stringify({ items });
  logger.info(`[TISTORY_CATEGORIES] ${body}`);
  logger.info(`[Tistory] [CATEGORIES] ${body}`);
}

function logNaverAuth(logger, payload) {
  logger.info(`[NAVER] [AUTH] ${JSON.stringify(payload)}`);
}

function extendBridgeProtocol(baseLogger) {
  return {
    ...baseLogger,
    logWorkflowStep(stepId, state, payload) {
      logWorkflowStep(this, stepId, state, payload);
    },
    logHtmlHandoff(payload) {
      logHtmlHandoff(this, payload);
    },
    logErrorCode(code, detail) {
      logErrorCode(this, code, detail);
    },
    logTistoryCategories(items) {
      logTistoryCategories(this, items);
    },
    logNaverAuth(payload) {
      logNaverAuth(this, payload);
    },
  };
}

module.exports = {
  extendBridgeProtocol,
  logWorkflowStep,
  logHtmlHandoff,
  logErrorCode,
  logTistoryCategories,
  logNaverAuth,
};
