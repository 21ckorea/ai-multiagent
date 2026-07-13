'use strict';

/**
 * @file common.js
 * @description 자동화 공통 유틸리티 모음
 * @purpose  sleep(), 날짜 포맷, 파일 I/O, 로그 헬퍼, bridge 프로토콜 초기화 등
 *           여러 모듈에서 공통으로 사용하는 순수 유틸 함수 집합.
 * @exports  sleep, waitFor, formatDate, extendBridgeProtocol, ...
 * @seeAlso  bridge_protocol.js
 */


const minimist = require('minimist');
const { extendBridgeProtocol } = require('./bridge_protocol');
const { GOOGLE_SIGNIN_URL } = require('./google_login');

const DEFAULT_URL = 'https://gemini.google.com/';
const MANUAL_AUTH_WAIT_MS = 5 * 60 * 1000;
const STEP_TIMEOUT_MS = 30 * 1000;

const POST_SUCCESS_HOLD_MS = (() => {
  if (process.env.JA_HOLD_SECONDS) {
    const parsed = Number.parseInt(process.env.JA_HOLD_SECONDS, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed * 1000;
    }
  }
  return 10 * 1000;
})();
/** Short hold after verify/refresh so the user sees success before the browser closes. */
const VERIFY_SUCCESS_HOLD_MS = 3 * 1000;

/**
 * Hold Tistory editor open after slot/image failure before browser close.
 * Override: JA_TISTORY_POST_FAILURE_HOLD_MS (milliseconds, 0 = fast-close).
 */
function resolveTistoryFailureHoldMs() {
  const raw = process.env.JA_TISTORY_POST_FAILURE_HOLD_MS;
  if (raw === undefined || String(raw).trim() === '') {
    return POST_SUCCESS_HOLD_MS;
  }
  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return POST_SUCCESS_HOLD_MS;
  }
  return parsed;
}
const COMPONENT_POLL_INTERVAL_MS = 1000;
const EMAIL_COMPONENT_MAX_ATTEMPTS = 10;
const PASSWORD_COMPONENT_MAX_ATTEMPTS = 12;
const FIELD_TYPE_DELAY_MS = 60;
const PASSWORD_MASK = '******';

/** Chrome flags to reduce automation fingerprinting (not a guarantee against Google blocks). */
const CHROME_STEALTH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--start-maximized',
];

const PLAYWRIGHT_STEALTH_IGNORE_DEFAULT_ARGS = ['--enable-automation'];

function applyPlaywrightStealthInitScript(context) {
  return context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });
  });
}

function applySeleniumStealthOptions(options) {
  options.excludeSwitches('enable-automation', 'enable-logging');
  for (const arg of CHROME_STEALTH_ARGS) {
    options.addArguments(arg);
  }
  return options;
}

const EXIT = {
  SUCCESS: 0,
  FAILED: 1,
  MANUAL_AUTH_TIMEOUT: 2,
};

const RESULT = {
  SUCCESS: 'SUCCESS',
  SUCCESS_AFTER_MANUAL_AUTH: 'SUCCESS_AFTER_MANUAL_AUTH',
  MANUAL_AUTH_REQUIRED: 'MANUAL_AUTH_REQUIRED',
  MANUAL_AUTH_TIMEOUT: 'MANUAL_AUTH_TIMEOUT',
  FAILED: 'FAILED',
};

function parseArgs() {
  const args = minimist(process.argv.slice(2), {
    string: ['email', 'password', 'url'],
    default: { url: DEFAULT_URL },
  });

  return {
    email: args.email || '',
    password: args.password || '',
    url: args.url || DEFAULT_URL,
  };
}

function sanitize(text, password) {
  if (!text || !password) {
    return text || '';
  }
  return text.split(password).join(PASSWORD_MASK);
}

function createLogger(engine) {
  return extendBridgeProtocol({
    info(message) {
      console.log(`[${engine}] ${message}`);
    },
    error(message, password = '') {
      console.error(`[${engine}] ${sanitize(message, password)}`);
    },
    result(status, message) {
      console.log(`[${engine}] [RESULT] ${status}: ${message}`);
    },
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRoutineGoogleSignInStepUrl(url) {
  return (
    GOOGLE_SIGNIN_URL.identifierStep.test(url) ||
    GOOGLE_SIGNIN_URL.passwordStep.test(url)
  );
}

function needsManualAuthFromSignals(url, bodyText) {
  // Password step URLs contain "challenge/pwd" — not a manual-auth prompt.
  if (isRoutineGoogleSignInStepUrl(url)) {
    return false;
  }

  if (/challenge|signin\/v2\/challenge|accounts\.google\.com\/v3\/signin\/challenge/i.test(url)) {
    return true;
  }

  return /captcha|recaptcha|2-step|two-step|2fa|verify it'?s you|confirm your identity|unusual activity|security check|기기 확인|본인 확인|휴대|phone number|sms code|안전하지 않|not be secure|couldn'?t sign you in/i.test(
    bodyText,
  );
}

function isSignInScreen(url, bodyText) {
  if (/accounts\.google\.com/i.test(url)) {
    return true;
  }

  return /sign in to continue|sign in to use|log in to use|로그인하여|로그인 후|로그인해야/i.test(bodyText);
}

async function evaluateGeminiReady({
  getUrl,
  getBodyText,
  requiresSignIn,
  hasSignedInSession,
  hasActivePrompt,
}) {
  const url = await getUrl();
  const bodyText = await getBodyText();

  if (!/gemini\.google\.com/i.test(url)) {
    return { ready: false, phase: 'navigation', detail: 'Not on gemini.google.com yet.' };
  }

  if (/accounts\.google\.com/i.test(url)) {
    return { ready: false, phase: 'sign_in', detail: 'Google accounts sign-in page.' };
  }

  const loginRequired = requiresSignIn
    ? await requiresSignIn()
    : isSignInScreen(url, bodyText);

  if (loginRequired) {
    return {
      ready: false,
      phase: 'sign_in',
      detail: 'Gemini login required (sign-in control visible).',
    };
  }

  if (hasSignedInSession && (await hasSignedInSession())) {
    return { ready: true, phase: 'ready', detail: 'Signed-in Google account session detected.' };
  }

  if (hasActivePrompt && (await hasActivePrompt())) {
    return { ready: true, phase: 'ready', detail: 'Active prompt input is available.' };
  }

  if (/gemini\.google\.com\/app/i.test(url) && !loginRequired) {
    return { ready: true, phase: 'ready', detail: 'Gemini app URL without sign-in control.' };
  }

  return { ready: false, phase: 'unknown', detail: 'Gemini authenticated state not confirmed.' };
}

async function waitForGeminiReady(evaluateReady, waitFn, timeoutMs, logger) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const state = await evaluateReady();
    if (state.ready) {
      return state;
    }
    await waitFn(2000);
  }

  const lastState = await evaluateReady();
  logger.info(`Gemini readiness timeout. Last state: ${lastState.detail}`);
  return lastState;
}

/**
 * Poll until checkReady() returns true, once per intervalMs, up to maxAttempts.
 */
async function waitForComponentReady({
  checkReady,
  beforeCheck,
  intervalMs = COMPONENT_POLL_INTERVAL_MS,
  maxAttempts = EMAIL_COMPONENT_MAX_ATTEMPTS,
  label = 'component',
  logger,
  waitFn = sleep,
}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (beforeCheck) {
      await beforeCheck();
    }

    try {
      if (await checkReady()) {
        logger.info(`${label} ready (attempt ${attempt}/${maxAttempts}).`);
        return true;
      }
    } catch {
      // Treat check errors as not ready and retry.
    }

    logger.info(`${label} not ready (attempt ${attempt}/${maxAttempts}).`);

    if (attempt < maxAttempts) {
      await waitFn(intervalMs);
    }
  }

  logger.info(`${label} not ready after ${maxAttempts} attempts.`);
  return false;
}

module.exports = {
  DEFAULT_URL,
  MANUAL_AUTH_WAIT_MS,
  STEP_TIMEOUT_MS,
  POST_SUCCESS_HOLD_MS,
  VERIFY_SUCCESS_HOLD_MS,
  resolveTistoryFailureHoldMs,
  COMPONENT_POLL_INTERVAL_MS,
  EMAIL_COMPONENT_MAX_ATTEMPTS,
  PASSWORD_COMPONENT_MAX_ATTEMPTS,
  FIELD_TYPE_DELAY_MS,
  PASSWORD_MASK,
  CHROME_STEALTH_ARGS,
  PLAYWRIGHT_STEALTH_IGNORE_DEFAULT_ARGS,
  applyPlaywrightStealthInitScript,
  applySeleniumStealthOptions,
  EXIT,
  RESULT,
  parseArgs,
  sanitize,
  createLogger,
  sleep,
  needsManualAuthFromSignals,
  isSignInScreen,
  evaluateGeminiReady,
  waitForGeminiReady,
  waitForComponentReady,
};
