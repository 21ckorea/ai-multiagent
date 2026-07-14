'use strict';

/**
 * @file playwright_gemini_test.js
 * @description Gemini Playwright 브라우저 초기화 및 세션 관리 (공통)
 * @purpose  Playwright 브라우저/컨텍스트/페이지 생성, Gemini URL 접속,
 *           로그인 상태 확인 등 Playwright 기반 Gemini 작업의 공통 기반 모듈.
 *           이름은 "test"이지만 실제로는 핵심 인프라 역할을 함.
 * @exports  runGeminiSessionFromProfile, PROFILE_DIR, openGeminiPage, ...
 * @seeAlso  playwright_gemini_compose.js, playwright_gemini_image.js, batch_publish.js
 */


const fs = require('fs');
const path = require('path');
const minimist = require('minimist');
const { chromium } = require('playwright');
const {
  exportCookies,
  importCookies,
  readSnapshotFile,
  writeSnapshotFile,
  logSessionEvent,
  snapshotHasAuthCookies,
} = require('./gemini_session');
const {
  MANUAL_AUTH_WAIT_MS,
  STEP_TIMEOUT_MS,
  POST_SUCCESS_HOLD_MS,
  EXIT,
  RESULT,
  DEFAULT_URL,
  parseArgs,
  createLogger,
  sleep,
  needsManualAuthFromSignals,
  evaluateGeminiReady,
  waitForGeminiReady,
  waitForComponentReady,
  COMPONENT_POLL_INTERVAL_MS,
  EMAIL_COMPONENT_MAX_ATTEMPTS,
  PASSWORD_COMPONENT_MAX_ATTEMPTS,
  CHROME_STEALTH_ARGS,
  PLAYWRIGHT_STEALTH_IGNORE_DEFAULT_ARGS,
  applyPlaywrightStealthInitScript,
  FIELD_TYPE_DELAY_MS,
} = require('./common');
const { GOOGLE_LOGIN, GOOGLE_SIGNIN_URL, GOOGLE_SPINNER_BRIEF_WAIT_MS, allEmailInputXPaths, allPasswordInputXPaths } = require('./google_login');

const ENGINE = 'Playwright';
const PROFILE_DIR = path.resolve(process.cwd(), 'profiles', 'playwright-gemini-profile');
const DEFAULT_GEMINI_IMPORT_PROFILE_DIR = path.resolve(
  process.cwd(),
  'profiles',
  'playwright-gemini-import-profile',
);
const DEFAULT_COOKIE_IMPORT_PATH = path.resolve(process.cwd(), 'build', 'gemini-cookies.json');
const GEMINI_SESSION_READY_MS = 60000;

function parseLoginArgs() {
  const args = minimist(process.argv.slice(2), {
    string: ['email', 'password', 'url', 'profile-dir', 'export-cookies'],
    default: { url: DEFAULT_URL },
  });

  const profileDirArg = args['profile-dir'];
  const profileDir =
    typeof profileDirArg === 'string' && profileDirArg.trim().length > 0
      ? path.resolve(process.cwd(), profileDirArg.trim())
      : PROFILE_DIR;

  const exportArg = args['export-cookies'];
  const exportPath =
    typeof exportArg === 'string' && exportArg.trim().length > 0
      ? path.resolve(process.cwd(), exportArg.trim())
      : null;

  return {
    email: args.email || '',
    password: args.password || '',
    url: args.url || DEFAULT_URL,
    profileDir,
    exportPath,
  };
}

async function exportSessionSnapshot(context, { exportPath, profileDir, logger }) {
  const snapshot = await exportCookies(context, {
    profileDir,
    source: 'playwright',
  });
  const writtenPath = writeSnapshotFile(exportPath, snapshot);

  logSessionEvent(logger, 'EXPORT', {
    path: writtenPath,
    total: snapshot.cookies.length,
    domains: snapshot.domains,
    hasAuthCookies: snapshotHasAuthCookies(snapshot),
    savedAt: snapshot.savedAt,
    profileDir,
    phase: 'login',
  });

  logger.info(`Cookie session exported during login (${snapshot.cookies.length} cookies).`);
  return snapshot.cookies.length;
}

async function getBodyText(page) {
  try {
    return (await page.locator('body').innerText({ timeout: 5000 })) || '';
  } catch {
    return '';
  }
}

function createGeminiEvaluator(page) {
  return {
    getUrl: async () => page.url(),
    getBodyText: () => getBodyText(page),
    requiresSignIn: async () => {
      for (const selector of GOOGLE_LOGIN.geminiSignInRequiredSelectors) {
        try {
          const locator = page.locator(selector).first();
          if (await locator.isVisible({ timeout: 1000 })) {
            return true;
          }
        } catch {
          // Try next selector.
        }
      }

      return false;
    },
    hasSignedInSession: async () => {
      for (const selector of GOOGLE_LOGIN.geminiSignedInSelectors) {
        try {
          const locator = page.locator(selector).first();
          if (await locator.isVisible({ timeout: 1000 })) {
            return true;
          }
        } catch {
          // Try next selector.
        }
      }

      return false;
    },
    hasActivePrompt: async () => {
      const selectors = [
        '[data-test-id="prompt-textarea"]',
        'rich-textarea',
        '[aria-label*="prompt" i]',
        'textarea',
        '[contenteditable="true"]',
      ];

      for (const selector of selectors) {
        try {
          const locator = page.locator(selector).first();
          if (!(await locator.isVisible({ timeout: 1500 }))) {
            continue;
          }

          const disabled = await locator.isDisabled().catch(() => false);
          const ariaDisabled = await locator.getAttribute('aria-disabled');
          const readonly = await locator.getAttribute('readonly');

          if (disabled || ariaDisabled === 'true' || readonly !== null) {
            continue;
          }

          return true;
        } catch {
          // Try next selector.
        }
      }

      return false;
    },
  };
}

async function isGeminiReady(page, logger) {
  const state = await evaluateGeminiReady(createGeminiEvaluator(page));
  logger.info(`Gemini check: ready=${state.ready}, phase=${state.phase}, detail=${state.detail}`);
  return state.ready;
}

async function needsManualAuth(page) {
  const url = page.url();
  const bodyText = await getBodyText(page);
  return needsManualAuthFromSignals(url, bodyText);
}

async function waitForGoogleLoginPage(page, logger) {
  try {
    await page.waitForURL(/accounts\.google\.com/i, { timeout: STEP_TIMEOUT_MS });
    logger.info('Google accounts login page loaded.');
    return true;
  } catch {
    try {
      await page.locator('c-wiz').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
      logger.info('Google login wizard (c-wiz) detected.');
      return true;
    } catch {
      return false;
    }
  }
}

async function waitForGoogleLoadingToFinish(page, logger) {
  for (const selector of GOOGLE_LOGIN.loadingSpinnerSelectors) {
    const spinner = page.locator(selector).first();
    try {
      if (await spinner.isVisible({ timeout: 500 })) {
        logger.info('Google loading spinner visible. Waiting briefly (will proceed anyway)...');
        try {
          await spinner.waitFor({ state: 'hidden', timeout: GOOGLE_SPINNER_BRIEF_WAIT_MS });
        } catch {
          logger.info('Spinner still visible after brief wait; proceeding with input entry.');
        }
      }
    } catch {
      // Spinner absent or already hidden.
    }
  }

  await page.waitForTimeout(200);
}

async function clickGoogleFieldContainer(page, containerXPath, logger, label) {
  try {
    const container = page.locator(`xpath=${containerXPath}`).first();
    if (await container.isVisible({ timeout: 3000 })) {
      await container.click({ timeout: STEP_TIMEOUT_MS });
      logger.info(`Clicked Google ${label} field area (XPath container fallback).`);
      await page.waitForTimeout(500);
      return true;
    }
  } catch {
    // Fall back to direct input interaction.
  }

  return false;
}

async function locateInputFromCandidates(page, cssSelectors, xpathSelectors, logger, label) {
  for (const selector of cssSelectors) {
    try {
      const input = page.locator(selector).first();
      if (!(await input.isVisible({ timeout: 2000 }))) {
        continue;
      }
      if (!(await input.isEnabled().catch(() => true))) {
        continue;
      }
      await input.click({ timeout: STEP_TIMEOUT_MS });
      logger.info(`${label} input focused via ${selector}.`);
      return input;
    } catch {
      // Try next selector.
    }
  }

  for (const xpath of xpathSelectors) {
    try {
      const input = page.locator(`xpath=${xpath}`).first();
      if (!(await input.isVisible({ timeout: 2000 }))) {
        continue;
      }
      if (!(await input.isEnabled().catch(() => true))) {
        continue;
      }
      await input.click({ timeout: STEP_TIMEOUT_MS });
      logger.info(`${label} input focused via xpath.`);
      return input;
    } catch {
      // Try next selector.
    }
  }

  return null;
}

async function findEmailInput(page, logger) {
  let input = await locateInputFromCandidates(
    page,
    GOOGLE_LOGIN.emailInputSelectors,
    allEmailInputXPaths(),
    logger,
    'Email',
  );

  if (input) {
    return input;
  }

  await clickGoogleFieldContainer(page, GOOGLE_LOGIN.emailContainerXPath, logger, 'email');
  input = await locateInputFromCandidates(
    page,
    GOOGLE_LOGIN.emailInputSelectors,
    allEmailInputXPaths(),
    logger,
    'Email',
  );

  return input;
}

async function findPasswordInput(page, logger) {
  let input = await locateInputFromCandidates(
    page,
    GOOGLE_LOGIN.passwordInputSelectors,
    allPasswordInputXPaths(),
    logger,
    'Password',
  );

  if (input) {
    return input;
  }

  await clickGoogleFieldContainer(page, GOOGLE_LOGIN.passwordContainerXPath, logger, 'password');
  input = await locateInputFromCandidates(
    page,
    GOOGLE_LOGIN.passwordInputSelectors,
    allPasswordInputXPaths(),
    logger,
    'Password',
  );

  return input;
}

async function isEmailInputReady(page) {
  for (const selector of GOOGLE_LOGIN.emailInputSelectors) {
    try {
      const input = page.locator(selector).first();
      if ((await input.isVisible({ timeout: 300 })) && (await input.isEnabled())) {
        return true;
      }
    } catch {
      // Try next selector.
    }
  }

  for (const xpath of allEmailInputXPaths()) {
    try {
      const input = page.locator(`xpath=${xpath}`).first();
      if ((await input.isVisible({ timeout: 300 })) && (await input.isEnabled())) {
        return true;
      }
    } catch {
      // Try next selector.
    }
  }

  return false;
}

async function isPasswordStepReady(page) {
  const url = page.url();
  if (GOOGLE_SIGNIN_URL.passwordStep.test(url)) {
    return true;
  }

  for (const selector of GOOGLE_LOGIN.passwordInputSelectors) {
    try {
      const input = page.locator(selector).first();
      if ((await input.isVisible({ timeout: 300 })) && (await input.isEnabled())) {
        return true;
      }
    } catch {
      // Try next selector.
    }
  }

  for (const xpath of allPasswordInputXPaths()) {
    try {
      const input = page.locator(`xpath=${xpath}`).first();
      if ((await input.isVisible({ timeout: 300 })) && (await input.isEnabled())) {
        return true;
      }
    } catch {
      // Try next selector.
    }
  }

  return false;
}

function pollWaitOptions(page, logger, label, maxAttempts) {
  return {
    intervalMs: COMPONENT_POLL_INTERVAL_MS,
    maxAttempts,
    label,
    logger,
    waitFn: (ms) => page.waitForTimeout(ms),
  };
}

async function waitForEmailInputReady(page, logger) {
  const landed = await waitForComponentReady({
    checkReady: () => isEmailInputReady(page),
    ...pollWaitOptions(page, logger, 'Email input landing', EMAIL_COMPONENT_MAX_ATTEMPTS),
  });

  if (!landed) {
    return null;
  }

  let emailInput = null;
  const focused = await waitForComponentReady({
    checkReady: async () => {
      emailInput = await findEmailInput(page, logger);
      return emailInput !== null;
    },
    ...pollWaitOptions(page, logger, 'Email input focus', EMAIL_COMPONENT_MAX_ATTEMPTS),
  });

  return focused ? emailInput : null;
}

async function waitForPasswordInputReady(page, logger) {
  const landed = await waitForComponentReady({
    checkReady: () => isPasswordStepReady(page),
    ...pollWaitOptions(page, logger, 'Password step landing', PASSWORD_COMPONENT_MAX_ATTEMPTS),
  });

  if (!landed) {
    return null;
  }

  let passwordInput = null;
  const focused = await waitForComponentReady({
    checkReady: async () => {
      passwordInput = await findPasswordInput(page, logger);
      return passwordInput !== null;
    },
    ...pollWaitOptions(page, logger, 'Password input focus', EMAIL_COMPONENT_MAX_ATTEMPTS),
  });

  return focused ? passwordInput : null;
}

async function fillInputReliably(page, input, value, logger, stepLabel) {
  await input.click({ timeout: STEP_TIMEOUT_MS });
  await page.waitForTimeout(400);
  await input.fill('');
  await input.pressSequentially(value, { delay: FIELD_TYPE_DELAY_MS });

  if (stepLabel === 'Password') {
    const length = await input.evaluate((el) => el.value.length);
    if (length !== value.length) {
      logger.info(`Password field length mismatch (expected ${value.length}, got ${length}). Retrying entry...`);
      await input.fill('');
      await page.waitForTimeout(300);
      await input.pressSequentially(value, { delay: FIELD_TYPE_DELAY_MS + 20 });
    }
  }
}

async function submitPasswordStep(page, passwordInput, logger) {
  const passwordNext = page.locator('#passwordNext button, #passwordNext').first();
  try {
    if (await passwordNext.isVisible({ timeout: 2000 })) {
      await passwordNext.click({ timeout: STEP_TIMEOUT_MS });
      logger.info('Password step submitted via Next button.');
      return;
    }
  } catch {
    // Fall back to Enter.
  }

  await submitFieldWithEnter(page, passwordInput, logger, 'Password');
}

async function submitEmailStep(page, emailInput, logger) {
  const identifierNext = page.locator('#identifierNext button, #identifierNext').first();

  try {
    if (await identifierNext.isVisible({ timeout: 2000 })) {
      await identifierNext.click({ timeout: STEP_TIMEOUT_MS });
      logger.info('Email step submitted via identifierNext button.');
      return;
    }
  } catch {
    // Fall back to Enter.
  }

  await submitFieldWithEnter(page, emailInput, logger, 'Email');
}

async function submitFieldWithEnter(page, input, logger, stepLabel) {
  await input.press('Enter');
  logger.info(`${stepLabel} step submitted with Enter key.`);
}

async function clickNextButton(page) {
  const candidates = [
    page.getByRole('button', { name: /next|다음/i }),
    page.locator('#identifierNext button'),
    page.locator('#passwordNext button'),
  ];

  for (const candidate of candidates) {
    try {
      const button = candidate.first();
      if (await button.isVisible({ timeout: 2000 })) {
        await button.click({ timeout: STEP_TIMEOUT_MS });
        return true;
      }
    } catch {
      // Try next candidate.
    }
  }

  return false;
}

async function clickSignInIfPresent(page, logger) {
  const cssCandidates = GOOGLE_LOGIN.geminiSignInSelectors.map((selector) => page.locator(selector).first());
  const roleCandidates = [
    page.getByRole('link', { name: /sign in|log in|로그인/i }),
    page.getByRole('button', { name: /sign in|log in|로그인/i }),
  ];

  for (const candidate of [...cssCandidates, ...roleCandidates]) {
    try {
      const element = candidate.first();
      if (await element.isVisible({ timeout: 3000 })) {
        logger.info('Sign-in control detected. Clicking sign-in...');
        await element.click({ timeout: STEP_TIMEOUT_MS });
        await waitForGoogleLoginPage(page, logger);
        await page.waitForTimeout(1500);
        return true;
      }
    } catch {
      // Try next candidate.
    }
  }

  return false;
}

async function tryEnterEmail(page, email, logger) {
  if (!email) {
    logger.info('Email argument is empty. Skipping automatic email entry.');
    return 'manual';
  }

  logger.info('Attempting to enter email...');
  await waitForGoogleLoadingToFinish(page, logger);

  const emailInput = await waitForEmailInputReady(page, logger);
  if (!emailInput) {
    logger.info('Email input not found.');
    return 'manual';
  }

  await fillInputReliably(page, emailInput, email, logger, 'Email');
  logger.info('Email entered.');
  await submitEmailStep(page, emailInput, logger);
  await page.waitForTimeout(800);

  const passwordLanded = await waitForComponentReady({
    checkReady: () => isPasswordStepReady(page),
    ...pollWaitOptions(page, logger, 'Password step landing', PASSWORD_COMPONENT_MAX_ATTEMPTS),
  });
  if (!passwordLanded) {
    logger.info('Password step did not become ready after email submission.');
    return 'manual';
  }

  return 'ok';
}

async function tryEnterPassword(page, password, logger) {
  if (!password) {
    logger.info('Password argument is empty. Skipping automatic password entry.');
    return 'manual';
  }

  logger.info('Attempting to enter password...');
  await waitForGoogleLoadingToFinish(page, logger);

  const passwordInput = await waitForPasswordInputReady(page, logger);
  if (!passwordInput) {
    logger.info('Password step is not ready. Manual authentication may be required.');
    return 'manual';
  }

  await fillInputReliably(page, passwordInput, password, logger, 'Password');
  logger.info('Password entered (value not logged).');
  await page.waitForTimeout(500);
  await submitPasswordStep(page, passwordInput, logger);
  await page.waitForTimeout(3000);

  return (await needsManualAuth(page)) ? 'manual' : 'ok';
}

async function waitForManualAuthCompletion(page, logger) {
  logger.result(RESULT.MANUAL_AUTH_REQUIRED, '사용자 수동 인증 필요');
  logger.info('Browser will stay open. Complete verification manually.');
  logger.info(`Waiting up to ${MANUAL_AUTH_WAIT_MS / 60000} minutes for Gemini to become ready...`);

  const state = await waitForGeminiReady(
    () => evaluateGeminiReady(createGeminiEvaluator(page)),
    (ms) => page.waitForTimeout(ms),
    MANUAL_AUTH_WAIT_MS,
    logger,
  );

  if (state.ready) {
    logger.result(RESULT.SUCCESS_AFTER_MANUAL_AUTH, 'Gemini page is ready after manual authentication.');
    return { success: true, exitCode: EXIT.SUCCESS };
  }

  logger.result(
    RESULT.MANUAL_AUTH_TIMEOUT,
    'Manual authentication was not completed within the wait period.',
  );
  logger.info(`Last URL: ${page.url()}`);
  return { success: false, exitCode: EXIT.MANUAL_AUTH_TIMEOUT };
}

async function runLoginFlow(page, email, password, logger) {
  if (await isGeminiReady(page, logger)) {
    logger.info('Already signed in. Skipping login flow.');
    return { success: true, exitCode: EXIT.SUCCESS };
  }

  logger.info('Not signed in. Starting login flow...');
  const signInClicked = await clickSignInIfPresent(page, logger);
  if (signInClicked) {
    logger.info('Sign-in navigation triggered.');
  }

  const emailInput = await findEmailInput(page, logger);
  if (!signInClicked && !emailInput && !/accounts\.google\.com/i.test(page.url())) {
    logger.info('No sign-in entry point detected. Waiting for manual authentication...');
    return waitForManualAuthCompletion(page, logger);
  }

  const emailResult = await tryEnterEmail(page, email, logger);
  if (emailResult === 'manual') {
    return waitForManualAuthCompletion(page, logger);
  }

  const passwordResult = await tryEnterPassword(page, password, logger);
  if (passwordResult === 'manual') {
    return waitForManualAuthCompletion(page, logger);
  }

  logger.info('Automatic login steps completed. Checking Gemini readiness...');
  if (await isGeminiReady(page, logger)) {
    logger.result(RESULT.SUCCESS, 'Gemini page is ready.');
    return { success: true, exitCode: EXIT.SUCCESS };
  }

  const state = await waitForGeminiReady(
    () => evaluateGeminiReady(createGeminiEvaluator(page)),
    (ms) => page.waitForTimeout(ms),
    60000,
    logger,
  );

  if (state.ready) {
    logger.result(RESULT.SUCCESS, 'Gemini page is ready.');
    return { success: true, exitCode: EXIT.SUCCESS };
  }

  return waitForManualAuthCompletion(page, logger);
}

async function run() {
  const { email, password, url, profileDir, exportPath } = parseLoginArgs();
  const logger = createLogger(ENGINE);
  let context = null;
  let exitCode = EXIT.SUCCESS;

  if (!email) {
    logger.info('Warning: --email is empty. Automatic login will be limited.');
  }

  if (exportPath) {
    logger.info(`Login will export session cookies to ${exportPath} before closing.`);
  }

  try {
    ({ context, exitCode } = await runGeminiLoginSession({
      email,
      password,
      url,
      profileDir,
      logger,
    }));

    if (exitCode === EXIT.SUCCESS && exportPath && context) {
      try {
        const total = await exportSessionSnapshot(context, { exportPath, profileDir, logger });
        logger.result(RESULT.SUCCESS, `Login and cookie export complete (${total} cookies).`);
      } catch (exportError) {
        const code =
          exportError && typeof exportError === 'object' && 'code' in exportError
            ? exportError.code
            : 'session_export_failed';
        logger.error(exportError instanceof Error ? exportError.message : String(exportError), password);
        logger.result(RESULT.FAILED, code);
        exitCode = EXIT.FAILED;
      }
    }
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error), password);
    logger.info('ERROR: Unexpected failure during automation.');

    if (context) {
      const page = context.pages()[0];
      if (page) {
        logger.info('Attempting manual authentication wait after error...');
        const outcome = await waitForManualAuthCompletion(page, logger);
        exitCode = outcome.exitCode;
        if (outcome.success) {
          logger.result(RESULT.SUCCESS, 'Recovered after manual authentication.');
        }
      } else {
        logger.result(RESULT.FAILED, 'Browser page unavailable after unexpected error.');
        exitCode = EXIT.FAILED;
      }
    } else {
      logger.result(RESULT.FAILED, 'Browser failed to launch.');
      exitCode = EXIT.FAILED;
    }
  } finally {
    const immediateClose = exportPath != null && exitCode === EXIT.SUCCESS;
    exitCode = await closeGeminiContext(context, logger, password, exitCode, {
      immediate: immediateClose,
    });
    process.exitCode = exitCode;
  }
}

async function launchGeminiContext(profileDir, logger, isHeadless = false) {
  logger.info(`Launching persistent Chrome context (headless: ${isHeadless})...`);
  logger.info(`Profile directory: ${profileDir}`);
  logger.info('Applying stealth launch flags (AutomationControlled mitigation).');

  const geminiArgs = [...CHROME_STEALTH_ARGS];
  if (isHeadless) {
    const idx = geminiArgs.indexOf('--start-maximized');
    if (idx > -1) geminiArgs.splice(idx, 1);
    geminiArgs.push('--window-position=-32000,-32000');
    geminiArgs.push('--window-size=1,1');
    geminiArgs.push('--noerrdialogs');
    geminiArgs.push('--no-sandbox');
  }

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: isHeadless,
    channel: 'chrome',
    args: geminiArgs,
    ignoreDefaultArgs: PLAYWRIGHT_STEALTH_IGNORE_DEFAULT_ARGS,
  });

  await applyPlaywrightStealthInitScript(context);
  const page = context.pages()[0] || (await context.newPage());
  logger.info('Browser launched.');
  return { context, page };
}

async function closeGeminiContext(context, logger, password, exitCode, options = {}) {
  if (!context) {
    return exitCode;
  }

  if (!options.immediate) {
    logger.info(`Holding browser open for ${POST_SUCCESS_HOLD_MS / 1000} seconds before closing...`);
    try {
      const page = context.pages()[0];
      if (page) {
        await page.waitForTimeout(POST_SUCCESS_HOLD_MS);
      } else {
        await sleep(POST_SUCCESS_HOLD_MS);
      }
    } catch {
      await sleep(POST_SUCCESS_HOLD_MS);
    }
  } else {
    logger.info('Fast-close: skipping post-success hold (abort/batch cleanup).');
  }

  await context.close().catch((closeError) => {
    logger.error(closeError instanceof Error ? closeError.message : String(closeError), password);
  });
  logger.info('Browser closed.');
  return exitCode;
}

async function runGeminiLoginSession({ email, password, url, profileDir = PROFILE_DIR, logger, isHeadless = false }) {
  const { context, page } = await launchGeminiContext(profileDir, logger, isHeadless);
  logger.info(`Navigating to ${url}`);

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  logger.info(`Current URL: ${page.url()}`);

  if (await isGeminiReady(page, logger)) {
    logger.result(RESULT.SUCCESS, 'Gemini page is ready (already signed in).');
    return { context, page, exitCode: EXIT.SUCCESS };
  }

  const outcome = await runLoginFlow(page, email, password, logger);
  return { context, page, exitCode: outcome.exitCode };
}

/**
 * Maps a login profile dir to its paired import profile dir (tenant-aware).
 * @param {string} [profileDir]
 */
function deriveGeminiImportProfileDir(profileDir) {
  const normalized = path.resolve(profileDir || PROFILE_DIR);
  const loginSuffix = `${path.sep}playwright-gemini-profile`;
  const importSuffix = `${path.sep}playwright-gemini-import-profile`;
  if (normalized.endsWith(loginSuffix)) {
    return `${normalized.slice(0, -loginSuffix.length)}${importSuffix}`;
  }
  if (normalized === PROFILE_DIR) {
    return DEFAULT_GEMINI_IMPORT_PROFILE_DIR;
  }
  return DEFAULT_GEMINI_IMPORT_PROFILE_DIR;
}

/**
 * Settings > Gemini Connect and batch publish use the saved login profile directly.
 * @param {string} [profileDir]
 * @param {string} [cookieImportPath]
 * @param {string} [importProfileDir]
 */
function resolveGeminiSessionProfileDir(profileDir, cookieImportPath, importProfileDir) {
  void cookieImportPath;
  void importProfileDir;
  return profileDir || PROFILE_DIR;
}

async function runGeminiSessionFromProfile({
  email,
  password,
  url,
  profileDir = PROFILE_DIR,
  logger,
  isHeadless = false,
}) {
  const sessionProfileDir = path.resolve(profileDir || PROFILE_DIR);
  let context = null;
  let page = null;

  try {
    logger.info(`Gemini session profile: ${sessionProfileDir}`);
    ({ context } = await launchGeminiContext(sessionProfileDir, logger, isHeadless));
    page = context.pages()[0] || (await context.newPage());

    await navigateGeminiPage(page, url, logger);
    logger.info(`Current URL: ${page.url()}`);

    if (await waitForGeminiPageReady(page, logger)) {
      logger.result(RESULT.SUCCESS, 'Gemini ready via saved Chrome profile.');
      return { context, page, exitCode: EXIT.SUCCESS, loginSkipped: true };
    }

    logger.info('Saved profile session not ready; falling back to credential login...');
    const outcome = await runLoginFlow(page, email, password, logger);
    return {
      context,
      page,
      exitCode: outcome.exitCode,
      loginSkipped: false,
    };
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error), password);
    if (context) {
      await closeGeminiContext(context, logger, password, EXIT.FAILED, { immediate: true });
    }
    return { context: null, page: null, exitCode: EXIT.FAILED, loginSkipped: false };
  }
}

async function navigateGeminiPage(page, url, logger, label = '') {
  const suffix = label ? ` (${label})` : '';
  logger.info(`Navigating to ${url}${suffix}...`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
}

async function waitForGeminiPageReady(page, logger) {
  if (await isGeminiReady(page, logger)) {
    return true;
  }
  const state = await waitForGeminiReady(
    () => evaluateGeminiReady(createGeminiEvaluator(page)),
    (ms) => page.waitForTimeout(ms),
    GEMINI_SESSION_READY_MS,
    logger,
  );
  return state.ready === true;
}

/**
 * Legacy `tryOpenIncognitoWithStoredGeminiSession` parity:
 * apply stored cookie snapshot first, then profile session, then credential login.
 */
async function runGeminiSessionWithCookieImport({
  email,
  password,
  url,
  profileDir = PROFILE_DIR,
  cookieImportPath,
  importProfileDir,
  logger,
  isHeadless = false,
}) {
  const resolvedImport = cookieImportPath
    ? path.resolve(String(cookieImportPath).trim())
    : DEFAULT_COOKIE_IMPORT_PATH;
  const sessionProfileDir = resolveGeminiSessionProfileDir(
    profileDir,
    resolvedImport,
    importProfileDir,
  );
  const hasCookieFile = fs.existsSync(resolvedImport);

  let context = null;
  let page = null;

  try {
    logger.info(`Gemini session profile: ${sessionProfileDir}`);
    ({ context } = await launchGeminiContext(sessionProfileDir, logger, isHeadless));
    page = context.pages()[0] || (await context.newPage());

    if (hasCookieFile) {
      logger.info(`Applying stored Gemini cookies from ${resolvedImport}...`);
      try {
        const snapshot = readSnapshotFile(resolvedImport);
        const importResult = await importCookies(context, snapshot);
        logSessionEvent(logger, 'IMPORT', {
          path: resolvedImport,
          profileDir: sessionProfileDir,
          ...importResult,
          hasAuthCookies: snapshotHasAuthCookies(snapshot),
        });
      } catch (importError) {
        const detail =
          importError instanceof Error ? importError.message : String(importError);
        logger.info(`Cookie import warning: ${detail} — continuing with navigation.`);
      }

      await navigateGeminiPage(page, url, logger);
      logger.info(`Current URL after cookie import: ${page.url()}`);

      if (await waitForGeminiPageReady(page, logger)) {
        logger.result(RESULT.SUCCESS, 'Gemini ready via stored session (login skipped).');
        return { context, page, exitCode: EXIT.SUCCESS, loginSkipped: true };
      }
      logger.info('Stored session not ready; falling back to credential login...');
    } else {
      logger.info(`No cookie snapshot at ${resolvedImport}; using profile/login flow.`);
      await navigateGeminiPage(page, url, logger);
      logger.info(`Current URL: ${page.url()}`);
    }

    if (await waitForGeminiPageReady(page, logger)) {
      logger.result(RESULT.SUCCESS, 'Gemini page is ready (already signed in).');
      return { context, page, exitCode: EXIT.SUCCESS, loginSkipped: false };
    }

    const outcome = await runLoginFlow(page, email, password, logger);
    return {
      context,
      page,
      exitCode: outcome.exitCode,
      loginSkipped: false,
    };
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error), password);

    if (page) {
      try {
        if (hasCookieFile) {
          logger.info(`Current URL after cookie import: ${page.url()}`);
        }
        await navigateGeminiPage(page, url, logger, 'recovery');
        if (await waitForGeminiPageReady(page, logger)) {
          logger.result(RESULT.SUCCESS, 'Gemini ready via stored session (login skipped).');
          return { context, page, exitCode: EXIT.SUCCESS, loginSkipped: true };
        }
        const outcome = await runLoginFlow(page, email, password, logger);
        return {
          context,
          page,
          exitCode: outcome.exitCode,
          loginSkipped: false,
        };
      } catch (recoveryError) {
        logger.error(
          recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
          password,
        );
      }
    }

    return { context, page, exitCode: EXIT.FAILED, loginSkipped: false };
  }
}

if (require.main === module) {
  run().catch((error) => {
    const logger = createLogger(ENGINE);
    logger.error(error instanceof Error ? error.message : String(error), parseArgs().password);
    logger.result(RESULT.FAILED, 'Unhandled script error.');
    process.exitCode = EXIT.FAILED;
  });
}

module.exports = {
  ENGINE,
  PROFILE_DIR,
  DEFAULT_GEMINI_IMPORT_PROFILE_DIR,
  DEFAULT_COOKIE_IMPORT_PATH,
  deriveGeminiImportProfileDir,
  resolveGeminiSessionProfileDir,
  launchGeminiContext,
  closeGeminiContext,
  isGeminiReady,
  run,
  runGeminiLoginSession,
  runGeminiSessionFromProfile,
  runGeminiSessionWithCookieImport,
  runLoginFlow,
};
