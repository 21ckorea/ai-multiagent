'use strict';

/**
 * @file kakao_login.js
 * @description 카카오 계정 로그인 자동화 (티스토리 로그인용)
 * @purpose  티스토리는 카카오 계정 OAuth로 로그인하므로, Playwright/Selenium으로
 *           카카오 로그인 UI(ID/PW 입력, 2FA 등)를 자동화하여 세션을 생성.
 * @exports  loginWithKakao, isKakaoLoggedIn
 * @seeAlso  playwright_tistory_login.js
 */


const { By } = require('selenium-webdriver');
const {
  waitForComponentReady,
  COMPONENT_POLL_INTERVAL_MS,
  EMAIL_COMPONENT_MAX_ATTEMPTS,
  FIELD_TYPE_DELAY_MS,
  sleep,
} = require('./common');

const KAKAO_ID_SELECTORS = [
  '#loginId--1',
  '[id^="loginId--"]',
  'input.tf_g[name="loginId"]',
  'input[name="loginId"]',
];

const KAKAO_PASSWORD_SELECTORS = [
  '#password--2',
  '[id^="password--"]',
  'input.tf_g[name="password"][type="password"]',
  'input[name="password"][type="password"]',
];

const KAKAO_SUBMIT_SELECTORS = [
  'button.btn_g.highlight.submit[type="submit"]',
  'button.btn_g.submit',
  'button[type="submit"].submit.btn_g',
];

/** Legacy scheduleKakaoPageAutofill retry gaps (bg-tistory-kakao-flow.js). */
const AUTOFILL_RETRY_DELAYS_MS = [0, 350, 600, 1800, 3500];
const KAKAO_POST_SUBMIT_NAV_TIMEOUT_MS = 45 * 1000;
const KAKAO_INPUT_ACTION_TIMEOUT_MS = 8000;

function parseUrlHostname(url) {
  if (typeof url !== 'string' || !url.trim()) {
    return '';
  }
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isKakaoLoginPage(url) {
  const host = parseUrlHostname(url);
  return host === 'accounts.kakao.com' || host.endsWith('.accounts.kakao.com');
}

function isKakaoOAuthAuthorizeUrl(url) {
  const host = parseUrlHostname(url);
  return host === 'kauth.kakao.com' || host.endsWith('.kauth.kakao.com');
}

function isKakaoAuthUrl(url) {
  return isKakaoLoginPage(url) || isKakaoOAuthAuthorizeUrl(url);
}

/** Legacy parity — OAuth consent is manual on kauth; log once and poll URL. */
function maybeLogKakaoOAuthManualWait(url, logger, state) {
  if (!isKakaoOAuthAuthorizeUrl(url)) {
    return;
  }
  if (state?.oauthHintLogged) {
    return;
  }
  if (state) {
    state.oauthHintLogged = true;
  }
  logger.info('Kakao OAuth consent — complete in browser (legacy parity: manual).');
}

async function findVisibleInput(page, selectors) {
  for (const selector of selectors) {
    try {
      const input = page.locator(selector).first();
      if ((await input.isVisible({ timeout: 500 })) && (await input.isEnabled())) {
        return input;
      }
    } catch {
      // Try next selector.
    }
  }
  return null;
}

async function isKakaoFormReady(page) {
  const idInput = await findVisibleInput(page, KAKAO_ID_SELECTORS);
  if (!idInput) {
    return false;
  }
  const pwInput = await findVisibleInput(page, KAKAO_PASSWORD_SELECTORS);
  return pwInput !== null;
}

async function setReactInputValue(input, value) {
  return input.evaluate((el, val) => {
    const old = el.value;
    el.focus();
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (desc && desc.set) {
      desc.set.call(el, val);
    } else {
      el.value = val;
    }
    const tracker = el._valueTracker;
    if (tracker && typeof tracker.setValue === 'function') {
      tracker.setValue(old);
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    try {
      el.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          inputType: 'insertFromPaste',
          data: val,
        }),
      );
    } catch {
      // ignore
    }
    return el.value.length;
  }, value);
}

async function fillInputReliably(page, input, value, logger, label) {
  try {
    await input.click({ timeout: KAKAO_INPUT_ACTION_TIMEOUT_MS });
    await page.waitForTimeout(250);
    await input.fill('', { timeout: KAKAO_INPUT_ACTION_TIMEOUT_MS });

    let length = await setReactInputValue(input, value);
    if (length !== value.length) {
      logger.info(`${label} React fill mismatch (expected ${value.length}, got ${length}). Retrying with pressSequentially...`);
      await input.fill('', { timeout: KAKAO_INPUT_ACTION_TIMEOUT_MS });
      await page.waitForTimeout(150);
      await input.pressSequentially(value, { delay: FIELD_TYPE_DELAY_MS });
      length = await input.evaluate((el) => el.value.length);
    }

    return length === value.length;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (!isKakaoLoginPage(page.url())) {
      logger.info(`${label} fill skipped — page navigated away during Kakao login (${msg.slice(0, 120)}).`);
      return false;
    }
    throw error;
  }
}

async function clickKakaoSubmitButton(page, btn, logger, message) {
  try {
    await Promise.all([
      page
        .waitForURL((candidate) => !isKakaoLoginPage(String(candidate)), {
          timeout: KAKAO_POST_SUBMIT_NAV_TIMEOUT_MS,
          waitUntil: 'domcontentloaded',
        })
        .catch(() => {}),
      btn.click({ timeout: KAKAO_INPUT_ACTION_TIMEOUT_MS }).then(() => {
        logger.info(message);
      }),
    ]);
    return true;
  } catch {
    try {
      await btn.click({ timeout: KAKAO_INPUT_ACTION_TIMEOUT_MS });
      logger.info(message);
      return true;
    } catch {
      return false;
    }
  }
}

async function submitKakaoLogin(page, logger) {
  for (const selector of KAKAO_SUBMIT_SELECTORS) {
    try {
      const btn = page.locator(selector).first();
      if ((await btn.isVisible({ timeout: 1500 })) && (await btn.isEnabled())) {
        return clickKakaoSubmitButton(
          page,
          btn,
          logger,
          'Kakao login submitted via submit button.',
        );
      }
    } catch {
      // Try next selector.
    }
  }

  try {
    const loginBtn = page.getByRole('button', { name: /로그인/i }).first();
    if ((await loginBtn.isVisible({ timeout: 1500 })) && (await loginBtn.isEnabled())) {
      return clickKakaoSubmitButton(
        page,
        loginBtn,
        logger,
        'Kakao login submitted via role button.',
      );
    }
  } catch {
    // Fall through.
  }

  return false;
}

/**
 * After login submit, wait until OAuth/Tistory redirect leaves accounts.kakao.com.
 */
async function waitForKakaoPostSubmitNavigation(page, logger, timeoutMs = KAKAO_POST_SUBMIT_NAV_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  logger.info('Waiting for Kakao redirect after login submit...');

  while (Date.now() < deadline) {
    let url = '';
    try {
      url = page.url();
    } catch {
      await page.waitForTimeout(400);
      continue;
    }

    if (!isKakaoLoginPage(url)) {
      logger.info(`Kakao redirect landed: ${url.slice(0, 140)}`);
      return { ok: true, url };
    }

    await page.waitForTimeout(400);
  }

  logger.info('Still on Kakao login page after waiting for redirect.');
  try {
    return { ok: false, url: page.url() };
  } catch {
    return { ok: false, url: '' };
  }
}

async function fillAndSubmit(page, loginId, password, logger) {
  try {
    const url = page.url();
    if (isKakaoOAuthAuthorizeUrl(url)) {
      return { ok: false, reason: 'oauth_manual', skipped: true };
    }
    if (!isKakaoLoginPage(url)) {
      return { ok: false, reason: 'not_on_kakao_login', skipped: true };
    }

    const ready = await isKakaoFormReady(page);
    if (!ready) {
      return { ok: false, reason: 'kakao_form_not_ready' };
    }

    const idInput = await findVisibleInput(page, KAKAO_ID_SELECTORS);
    const pwInput = await findVisibleInput(page, KAKAO_PASSWORD_SELECTORS);
    if (!idInput || !pwInput) {
      return { ok: false, reason: 'kakao_inputs_not_found' };
    }

    const idOk = await fillInputReliably(page, idInput, loginId, logger, 'Kakao ID');
    if (!idOk) {
      if (!isKakaoLoginPage(page.url())) {
        return { ok: true, submitted: true, reason: 'kakao_navigating', skipped: true };
      }
      return { ok: false, reason: 'kakao_id_fill_failed' };
    }
    logger.info('Kakao ID entered.');

    const pwOk = await fillInputReliably(page, pwInput, password, logger, 'Kakao password');
    if (!pwOk) {
      if (!isKakaoLoginPage(page.url())) {
        return { ok: true, submitted: true, reason: 'kakao_navigating', skipped: true };
      }
      return { ok: false, reason: 'kakao_password_fill_failed' };
    }
    logger.info('Kakao password entered (value not logged).');

    await page.waitForTimeout(300);

    let submitted = await submitKakaoLogin(page, logger);
    if (!submitted) {
      for (let attempt = 1; attempt <= 12; attempt += 1) {
        await page.waitForTimeout(120);
        if (!isKakaoLoginPage(page.url())) {
          return { ok: true, mode: 'locator', submitted: true, reason: 'kakao_navigating' };
        }
        submitted = await submitKakaoLogin(page, logger);
        if (submitted) {
          break;
        }
      }
    }

    if (!submitted) {
      return { ok: false, reason: 'kakao_submit_failed', filled: true };
    }

    return { ok: true, mode: 'locator', submitted: true };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (!isKakaoLoginPage(page.url())) {
      logger.info(`Kakao fillAndSubmit ended by navigation: ${msg.slice(0, 120)}`);
      return { ok: true, submitted: true, reason: 'kakao_navigating', skipped: true };
    }
    logger.info(`Kakao fillAndSubmit error: ${msg.slice(0, 160)}`);
    return { ok: false, reason: 'kakao_autofill_error' };
  }
}

async function scheduleKakaoAutofill(page, loginId, password, logger) {
  let lastResult = { ok: false, reason: 'kakao_autofill_exhausted' };

  for (const delay of AUTOFILL_RETRY_DELAYS_MS) {
    if (delay > 0) {
      await page.waitForTimeout(delay);
    }

    try {
      const url = page.url();
      if (isKakaoOAuthAuthorizeUrl(url)) {
        return { ok: true, skipped: true, reason: 'oauth_manual' };
      }
      if (!isKakaoLoginPage(url)) {
        return { ok: true, skipped: true };
      }

      const result = await fillAndSubmit(page, loginId, password, logger);
      lastResult = result;
      if (result.ok && result.submitted) {
        await waitForKakaoPostSubmitNavigation(page, logger).catch(() => {});
        return result;
      }
      if (result.reason === 'kakao_form_not_ready') {
        logger.info('Kakao form not ready on this attempt; will retry.');
      }
    } catch (error) {
      logger.info(`Kakao autofill attempt failed: ${error instanceof Error ? error.message : String(error)}`);
      lastResult = { ok: false, reason: 'kakao_autofill_error' };
    }
  }

  return lastResult;
}

async function readKakaoDescError(page) {
  return page.evaluate(() => {
    const box = document.querySelector('.box_desc[role="alert"]');
    const el = (box && box.querySelector('.desc_error')) || document.querySelector('.desc_error');
    if (!el) {
      return '';
    }
    return (el.textContent || '').replace(/\u200b/g, '').trim();
  });
}

async function installKakaoDescErrorObserver(page) {
  const exposeName = '__jablyKakaoLoginError';

  await page.evaluate((fnName) => {
    const w = globalThis;
    if (w.__autoBlogKakaoDescErrWatch) {
      return;
    }
    w.__autoBlogKakaoDescErrWatch = true;

    let done = false;
    let obs = null;

    function fire(text) {
      if (done) {
        return;
      }
      const t = (text || '').replace(/\s+/g, ' ').trim();
      if (!t) {
        return;
      }
      done = true;
      try {
        obs?.disconnect();
      } catch {
        // ignore
      }
      const fn = w[fnName];
      if (typeof fn === 'function') {
        fn(t.slice(0, 500)).catch(() => {});
      }
    }

    function check() {
      const box = document.querySelector('.box_desc[role="alert"]');
      const el = (box && box.querySelector('.desc_error')) || document.querySelector('.desc_error');
      if (!el) {
        return;
      }
      const text = (el.textContent || '').replace(/\u200b/g, '').trim();
      if (text.length > 0) {
        fire(text);
      }
    }

    obs = new MutationObserver(() => check());
    obs.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    check();

    const iv = globalThis.setInterval(() => {
      if (done) {
        globalThis.clearInterval(iv);
        return;
      }
      check();
    }, 400);
    globalThis.setTimeout(() => globalThis.clearInterval(iv), 90000);
    globalThis.setTimeout(() => {
      try {
        obs?.disconnect();
      } catch {
        // ignore
      }
    }, 120000);
  }, exposeName);
}

function startKakaoErrorWatch(page, logger) {
  let stopped = false;
  let errorDetail = null;
  const exposeName = '__jablyKakaoLoginError';

  const bindObserver = async () => {
    try {
      await page.exposeFunction(exposeName, (detail) => {
        if (stopped || !detail) {
          return;
        }
        errorDetail = String(detail).trim().slice(0, 500);
        logger.info('Kakao login error detected (.desc_error).');
      });
    } catch {
      // Already exposed; replace handler via evaluate callback only on first page.
    }

    try {
      await installKakaoDescErrorObserver(page);
    } catch (error) {
      logger.info(
        `Kakao error observer install failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  void bindObserver();

  const timer = setInterval(() => {
    if (stopped || errorDetail) {
      return;
    }
    void readKakaoDescError(page)
      .then((detail) => {
        if (detail && !stopped) {
          errorDetail = detail.slice(0, 500);
          logger.info('Kakao login error detected (.desc_error poll fallback).');
        }
      })
      .catch(() => {});
  }, 400);

  return {
    getError() {
      return errorDetail;
    },
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

async function getCurrentUrlDriver(driver) {
  try {
    return await driver.getCurrentUrl();
  } catch {
    return '';
  }
}

async function findVisibleInputDriver(driver, selectors) {
  for (const selector of selectors) {
    try {
      const elements = await driver.findElements(By.css(selector));
      for (const element of elements) {
        if ((await element.isDisplayed()) && (await element.isEnabled())) {
          return element;
        }
      }
    } catch {
      // Try next selector.
    }
  }
  return null;
}

async function isKakaoFormReadyDriver(driver) {
  const idInput = await findVisibleInputDriver(driver, KAKAO_ID_SELECTORS);
  if (!idInput) {
    return false;
  }
  const pwInput = await findVisibleInputDriver(driver, KAKAO_PASSWORD_SELECTORS);
  return pwInput !== null;
}

async function setReactInputValueDriver(driver, element, value) {
  return driver.executeScript(
    function (el, val) {
      const old = el.value;
      el.focus();
      const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      if (desc && desc.set) {
        desc.set.call(el, val);
      } else {
        el.value = val;
      }
      const tracker = el._valueTracker;
      if (tracker && typeof tracker.setValue === 'function') {
        tracker.setValue(old);
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      try {
        el.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            inputType: 'insertFromPaste',
            data: val,
          }),
        );
      } catch {
        // ignore
      }
      return el.value.length;
    },
    element,
    value,
  );
}

async function fillInputReliablyDriver(driver, input, value, logger, label) {
  await input.click();
  await sleep(250);
  await input.clear();

  let length = await setReactInputValueDriver(driver, input, value);
  if (length !== value.length) {
    logger.info(
      `${label} React fill mismatch (expected ${value.length}, got ${length}). Retrying with sendKeys...`,
    );
    await input.clear();
    await sleep(150);
    for (const char of value) {
      await input.sendKeys(char);
      await sleep(FIELD_TYPE_DELAY_MS);
    }
    const currentValue = await input.getAttribute('value');
    length = currentValue ? currentValue.length : 0;
  }

  return length === value.length;
}

async function submitKakaoLoginDriver(driver, logger) {
  for (const selector of KAKAO_SUBMIT_SELECTORS) {
    try {
      const elements = await driver.findElements(By.css(selector));
      for (const btn of elements) {
        if ((await btn.isDisplayed()) && (await btn.isEnabled())) {
          await btn.click();
          logger.info('Kakao login submitted via submit button.');
          return true;
        }
      }
    } catch {
      // Try next selector.
    }
  }

  try {
    const buttons = await driver.findElements(By.xpath("//button[contains(., '로그인')]"));
    for (const btn of buttons) {
      if ((await btn.isDisplayed()) && (await btn.isEnabled())) {
        await btn.click();
        logger.info('Kakao login submitted via role button.');
        return true;
      }
    }
  } catch {
    // Fall through.
  }

  return false;
}

async function fillAndSubmitDriver(driver, loginId, password, logger) {
  const url = await getCurrentUrlDriver(driver);
  if (isKakaoOAuthAuthorizeUrl(url)) {
    return { ok: false, reason: 'oauth_manual', skipped: true };
  }
  if (!isKakaoLoginPage(url)) {
    return { ok: false, reason: 'not_on_kakao_login', skipped: true };
  }

  const ready = await isKakaoFormReadyDriver(driver);
  if (!ready) {
    return { ok: false, reason: 'kakao_form_not_ready' };
  }

  const idInput = await findVisibleInputDriver(driver, KAKAO_ID_SELECTORS);
  const pwInput = await findVisibleInputDriver(driver, KAKAO_PASSWORD_SELECTORS);
  if (!idInput || !pwInput) {
    return { ok: false, reason: 'kakao_inputs_not_found' };
  }

  const idOk = await fillInputReliablyDriver(driver, idInput, loginId, logger, 'Kakao ID');
  if (!idOk) {
    return { ok: false, reason: 'kakao_id_fill_failed' };
  }
  logger.info('Kakao ID entered.');

  const pwOk = await fillInputReliablyDriver(driver, pwInput, password, logger, 'Kakao password');
  if (!pwOk) {
    return { ok: false, reason: 'kakao_password_fill_failed' };
  }
  logger.info('Kakao password entered (value not logged).');

  await sleep(300);

  let submitted = await submitKakaoLoginDriver(driver, logger);
  if (!submitted) {
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      await sleep(120);
      submitted = await submitKakaoLoginDriver(driver, logger);
      if (submitted) {
        break;
      }
    }
  }

  if (!submitted) {
    return { ok: false, reason: 'kakao_submit_failed', filled: true };
  }

  return { ok: true, mode: 'locator', submitted: true };
}

async function scheduleKakaoAutofillDriver(driver, loginId, password, logger) {
  let lastResult = { ok: false, reason: 'kakao_autofill_exhausted' };

  for (const delay of AUTOFILL_RETRY_DELAYS_MS) {
    if (delay > 0) {
      await sleep(delay);
    }

    try {
      const url = await getCurrentUrlDriver(driver);
      if (isKakaoOAuthAuthorizeUrl(url)) {
        return { ok: true, skipped: true, reason: 'oauth_manual' };
      }
      if (!isKakaoLoginPage(url)) {
        return { ok: true, skipped: true };
      }

      const result = await fillAndSubmitDriver(driver, loginId, password, logger);
      lastResult = result;
      if (result.ok && result.submitted) {
        return result;
      }
      if (result.reason === 'kakao_form_not_ready') {
        logger.info('Kakao form not ready on this attempt; will retry.');
      }
    } catch (error) {
      logger.info(`Kakao autofill attempt failed: ${error instanceof Error ? error.message : String(error)}`);
      lastResult = { ok: false, reason: 'kakao_autofill_error' };
    }
  }

  return lastResult;
}

async function readKakaoDescErrorDriver(driver) {
  return driver.executeScript(() => {
    const box = document.querySelector('.box_desc[role="alert"]');
    const el = (box && box.querySelector('.desc_error')) || document.querySelector('.desc_error');
    if (!el) {
      return '';
    }
    return (el.textContent || '').replace(/\u200b/g, '').trim();
  });
}

async function installKakaoDescErrorObserverDriver(driver) {
  await driver.executeScript(() => {
    const w = globalThis;
    if (w.__autoBlogKakaoDescErrWatch) {
      return;
    }
    w.__autoBlogKakaoDescErrWatch = true;
    w.__jablyKakaoLoginErrorText = '';

    let done = false;
    let obs = null;

    function fire(text) {
      if (done) {
        return;
      }
      const t = (text || '').replace(/\s+/g, ' ').trim();
      if (!t) {
        return;
      }
      done = true;
      w.__jablyKakaoLoginErrorText = t.slice(0, 500);
      try {
        obs?.disconnect();
      } catch {
        // ignore
      }
    }

    function check() {
      const box = document.querySelector('.box_desc[role="alert"]');
      const el = (box && box.querySelector('.desc_error')) || document.querySelector('.desc_error');
      if (!el) {
        return;
      }
      const text = (el.textContent || '').replace(/\u200b/g, '').trim();
      if (text.length > 0) {
        fire(text);
      }
    }

    obs = new MutationObserver(() => check());
    obs.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    check();

    const iv = globalThis.setInterval(() => {
      if (done) {
        globalThis.clearInterval(iv);
        return;
      }
      check();
    }, 400);
    globalThis.setTimeout(() => globalThis.clearInterval(iv), 90000);
    globalThis.setTimeout(() => {
      try {
        obs?.disconnect();
      } catch {
        // ignore
      }
    }, 120000);
  });
}

function startKakaoErrorWatchDriver(driver, logger) {
  let stopped = false;
  let errorDetail = null;

  void installKakaoDescErrorObserverDriver(driver).catch((error) => {
    logger.info(
      `Kakao error observer install failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  const timer = setInterval(() => {
    if (stopped || errorDetail) {
      return;
    }
    void (async () => {
      try {
        const stored = await driver.executeScript(
          () => globalThis.__jablyKakaoLoginErrorText || '',
        );
        if (stored) {
          errorDetail = String(stored).trim().slice(0, 500);
          logger.info('Kakao login error detected (.desc_error).');
          return;
        }
        const detail = await readKakaoDescErrorDriver(driver);
        if (detail && !stopped) {
          errorDetail = detail.slice(0, 500);
          logger.info('Kakao login error detected (.desc_error poll fallback).');
        }
      } catch {
        // Page may be navigating.
      }
    })();
  }, 400);

  return {
    getError() {
      return errorDetail;
    },
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

/**
 * @param {'playwright'|'selenium'} engine
 */
function createKakaoLoginApi(engine) {
  if (engine === 'selenium') {
    return {
      fillAndSubmit: fillAndSubmitDriver,
      scheduleKakaoAutofill: scheduleKakaoAutofillDriver,
      startKakaoErrorWatch: startKakaoErrorWatchDriver,
      isKakaoAuthUrl,
      isKakaoLoginPage,
      isKakaoOAuthAuthorizeUrl,
      maybeLogKakaoOAuthManualWait,
    };
  }

  return {
    fillAndSubmit,
    scheduleKakaoAutofill,
    startKakaoErrorWatch,
    isKakaoAuthUrl,
    isKakaoLoginPage,
    isKakaoOAuthAuthorizeUrl,
    maybeLogKakaoOAuthManualWait,
    waitForKakaoPostSubmitNavigation,
  };
}

module.exports = {
  KAKAO_ID_SELECTORS,
  KAKAO_PASSWORD_SELECTORS,
  KAKAO_SUBMIT_SELECTORS,
  AUTOFILL_RETRY_DELAYS_MS,
  KAKAO_POST_SUBMIT_NAV_TIMEOUT_MS,
  isKakaoAuthUrl,
  isKakaoLoginPage,
  isKakaoOAuthAuthorizeUrl,
  maybeLogKakaoOAuthManualWait,
  waitForKakaoPostSubmitNavigation,
  isKakaoFormReady,
  fillAndSubmit,
  scheduleKakaoAutofill,
  readKakaoDescError,
  startKakaoErrorWatch,
  fillAndSubmitDriver,
  scheduleKakaoAutofillDriver,
  startKakaoErrorWatchDriver,
  createKakaoLoginApi,
};
