'use strict';

/**
 * @file google_login.js
 * @description Google 계정 로그인 자동화 (Playwright)
 * @purpose  Gemini 접속을 위한 Google 계정 OAuth 로그인 흐름을 Playwright로 자동화.
 *           프로필 디렉토리에 세션을 저장해 재로그인 없이 재사용 가능.
 * @exports  loginWithGoogle, isGoogleLoggedIn
 * @seeAlso  playwright_gemini_test.js, gemini_session_host.js
 */


/**
 * Google account login selectors for Gemini sign-in flow.
 * Absolute XPaths are fallbacks; relative c-wiz selectors are preferred when DOM shifts.
 */
const GOOGLE_LOGIN = {
  geminiSignInSelectors: [
    'a[aria-label="로그인"]',
    'a.gb_0a.gb_2d',
    'a[href*="accounts.google.com/ServiceLogin"]',
    'a[href*="accounts.google.com"]',
  ],

  emailContainerXPath:
    '/html/body/div[2]/div[1]/div[1]/div[2]/c-wiz/main/div[2]/div/div/div[1]/span/section/div/div/div[1]/div[1]/div[1]',

  passwordContainerXPath:
    '/html/body/div[2]/div[1]/div[1]/div[2]/c-wiz/main/div[2]/div/div/div/span/section[2]/div/div/div[1]/div[1]/div/div/div/div/div[1]',

  /** Verified absolute input XPaths (preferred before relative fallbacks). */
  emailInputAbsoluteXPaths: [
    '/html/body/div[2]/div[1]/div[1]/div[2]/c-wiz/main/div[2]/div/div/div[1]/span/section/div/div/div[1]/div[1]/div[1]/div/div[1]/input',
  ],

  passwordInputAbsoluteXPaths: [
    '/html/body/div[2]/div[1]/div[1]/div[2]/c-wiz/main/div[2]/div/div/div/span/section[2]/div/div/div[1]/div[1]/div/div/div/div/div[1]/div/div[1]/input',
  ],

  emailInputRelativeXPaths: [
    '//c-wiz//section[1]//input[@type="email" or @name="identifier" or @id="identifierId"]',
    '//c-wiz//input[@type="email" or @name="identifier" or @id="identifierId"]',
    '//input[@type="email" or @name="identifier" or @id="identifierId"]',
  ],

  passwordInputRelativeXPaths: [
    '//c-wiz//section[2]//input[@type="password" or @name="Passwd"]',
    '//c-wiz//input[@type="password" or @name="Passwd"]',
    '//input[@type="password" or @name="Passwd"]',
  ],

  /** Visible on Gemini when user is NOT signed in */
  geminiSignInRequiredSelectors: [
    'a[aria-label="로그인"]',
    'a.gb_0a.gb_2d',
    'a[href*="accounts.google.com/ServiceLogin"]',
  ],

  /** Visible on Gemini when user IS signed in */
  geminiSignedInSelectors: [
    'img[src*="googleusercontent.com/a/"]',
    'img[alt*="Profile" i]',
    'img[alt*="프로필"]',
    'gb-avatar',
  ],

  loadingSpinnerSelectors: [
    'div[role="progressbar"][aria-label="로드 중"]',
    'div[role="progressbar"][aria-label="Loading"]',
    'div[role="progressbar"][aria-busy="true"]',
  ],

  passwordInputSelectors: [
    'input[name="Passwd"]',
    'input[type="password"]',
  ],

  emailInputSelectors: [
    'input#identifierId',
    'input[name="identifier"]',
    'input[type="email"]',
  ],
};

const GOOGLE_SIGNIN_URL = {
  passwordStep: /signin\/.*(?:challenge\/pwd|challenge\/ipp|pwd)|Passwd|\/password/i,
  identifierStep: /signin\/identifier/i,
};

/** Brief spinner wait; login proceeds even if spinner stays visible. */
const GOOGLE_SPINNER_BRIEF_WAIT_MS = 3000;

function allEmailInputXPaths() {
  return [
    ...GOOGLE_LOGIN.emailInputAbsoluteXPaths,
    `${GOOGLE_LOGIN.emailContainerXPath}//input`,
    ...GOOGLE_LOGIN.emailInputRelativeXPaths,
  ];
}

function allPasswordInputXPaths() {
  return [
    ...GOOGLE_LOGIN.passwordInputAbsoluteXPaths,
    `${GOOGLE_LOGIN.passwordContainerXPath}//input`,
    ...GOOGLE_LOGIN.passwordInputRelativeXPaths,
  ];
}

module.exports = {
  GOOGLE_LOGIN,
  GOOGLE_SIGNIN_URL,
  GOOGLE_SPINNER_BRIEF_WAIT_MS,
  allEmailInputXPaths,
  allPasswordInputXPaths,
};
