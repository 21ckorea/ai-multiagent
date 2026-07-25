'use strict';

/**
 * @file tistory_tab_policy.js
 * @description 티스토리 탭/창 정책 관리
 * @purpose  파이프라인 중 불필요한 팝업/탭이 열릴 경우 자동으로 닫고,
 *           올바른 에디터 탭에서 작업이 진행되도록 탭 포커스를 관리.
 * @exports  shouldReuseTistoryBrowserForBatch, applyTistoryTabPolicy
 * @seeAlso  batch_publish.js
 */


const { isOnTistoryNewPost, isOnTistorySite, parseUrlHostname } = require('./tistory_common');

/** Default: keep hub/login tabs open during publish (multi-topic session stability). */
const DEFAULT_PUBLISH_TAB_POLICY = Object.freeze({
  closeHubTabAfterNewpost: false,
  preferSameTabNewpostNavigation: true,
});

/**
 * www.tistory.com (or blog host) landing without /manage/* — session hub after Kakao OAuth.
 * @param {string} url
 * @returns {boolean}
 */
function isTistoryHubHomeUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) {
    return false;
  }
  const host = parseUrlHostname(raw);
  if (!/(?:^|\.)tistory\.com$/i.test(host)) {
    return false;
  }
  if (/\/manage\//i.test(raw)) {
    return false;
  }
  return isOnTistorySite(raw);
}

/**
 * @param {object} [overrides]
 * @returns {{ closeHubTabAfterNewpost: boolean, preferSameTabNewpostNavigation: boolean }}
 */
function resolvePublishTabPolicy(overrides = {}) {
  return {
    closeHubTabAfterNewpost:
      overrides.closeHubTabAfterNewpost === true,
    preferSameTabNewpostNavigation:
      overrides.preferSameTabNewpostNavigation !== false,
  };
}

/**
 * Reuse one Playwright persistent context across immediate batch slots (same blog).
 * @param {object} job
 * @param {number} slotCount
 * @returns {boolean}
 */
function shouldReuseTistoryBrowserForBatch(job, slotCount) {
  if (!job || job.flowTarget !== 'tistory') {
    return false;
  }
  const n = Number(slotCount);
  return Number.isFinite(n) && n > 1;
}

module.exports = {
  DEFAULT_PUBLISH_TAB_POLICY,
  isTistoryHubHomeUrl,
  resolvePublishTabPolicy,
  shouldReuseTistoryBrowserForBatch,
};
