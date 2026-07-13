'use strict';

/**
 * @file google_sheets.js
 * @description Google Sheets API 클라이언트
 * @purpose  주제 추출 결과를 Google Sheets 스프레드시트에 자동으로 기록함.
 *           OAuth2 인증 후 시트 데이터 읽기/쓰기를 처리.
 * @exports  initAuth, getSheetNameByGid, appendRows, ...
 * @seeAlso  topic_extractor.js, electron-main.js
 */


const { google } = require('googleapis');
const fs = require('fs');

let authClient = null;
let sheetsApi = null;

/**
 * Initialize Google Sheets authentication using a Service Account JSON.
 * @param {string} credentialsPath - Path to the Service Account JSON file.
 */
function initAuth(credentialsPath) {
  if (!fs.existsSync(credentialsPath)) {
    throw new Error(`Credentials file not found: ${credentialsPath}`);
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: credentialsPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  authClient = auth;
  sheetsApi = google.sheets({ version: 'v4', auth: authClient });
}

/**
 * Reads the sheet and finds the first row where '포스트 완료여부' is empty.
 * Returns the '추천 블로그 포스팅 제목' and the row number, or null if no pending row found.
 * 
 * @param {string} spreadsheetId 
 * @param {string} sheetName 
 * @returns {Promise<{rowNumber: number, title: string}|null>}
 */
async function fetchNextPendingRow(spreadsheetId, sheetName) {
  if (!sheetsApi) throw new Error('Google Sheets API is not initialized. Call initAuth() first.');

  const range = `${sheetName}`;
  const response = await sheetsApi.spreadsheets.values.get({
    spreadsheetId,
    range,
  });

  const rows = response.data.values;
  if (!rows || rows.length === 0) {
    return null;
  }

  const findColIndex = (headers, possibleNames) => {
    return headers.findIndex(h => {
      if (!h) return false;
      const normalized = String(h).replace(/\s+/g, '');
      return possibleNames.some(p => normalized.includes(p.replace(/\s+/g, '')));
    });
  };

  // Row 1 is header
  const headers = rows[0];
  const statusColIndex = findColIndex(headers, ['포스트 완료여부', '완료여부']);
  const titleColIndex = findColIndex(headers, ['추천 블로그 포스팅 제목', '포스팅 제목', '제목']);
  const accountColIndex = findColIndex(headers, ['계정', '계정명']);

  if (statusColIndex === -1) throw new Error('Sheet is missing "포스트 완료여부" column.');
  if (titleColIndex === -1) throw new Error('Sheet is missing "추천 블로그 포스팅 제목" column.');

  // Find first row (index > 0) where status is empty
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const status = row[statusColIndex] || '';
    if (status.trim() === '') {
      const title = row[titleColIndex] || '';
      if (title.trim() !== '') {
        return {
          rowNumber: i + 1, // 1-based index for A1 notation
          title: title.trim(),
          account: accountColIndex !== -1 ? (row[accountColIndex] || '').trim() : '',
        };
      }
    }
  }

  return null; // All done or no titles
}

/**
 * Marks the specified row as "완료" in the "포스트 완료여부" column.
 * 
 * @param {string} spreadsheetId 
 * @param {string} sheetName 
 * @param {number} rowNumber 
 * @returns {Promise<void>}
 */
async function markRowAsCompleted(spreadsheetId, sheetName, rowNumber) {
  if (!sheetsApi) throw new Error('Google Sheets API is not initialized. Call initAuth() first.');

  // First we need to find which column letter corresponds to '포스트 완료여부' and '완료시간'
  const headerResponse = await sheetsApi.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!1:1`,
  });

  const findColIndex = (headers, possibleNames) => {
    return headers.findIndex(h => {
      if (!h) return false;
      const normalized = String(h).replace(/\s+/g, '');
      return possibleNames.some(p => normalized.includes(p.replace(/\s+/g, '')));
    });
  };

  const headers = headerResponse.data.values[0];
  const statusColIndex = findColIndex(headers, ['포스트 완료여부', '완료여부']);
  const endColIndex = findColIndex(headers, ['완료시간', '완료 시간']);
  if (statusColIndex === -1) throw new Error('Sheet is missing "포스트 완료여부" column.');

  // Convert column index to letter (A, B, C...)
  // Works up to Z. If it goes to AA, we need a better converter, but usually it's within A-Z.
  const getColLetter = (index) => {
    let letter = '';
    let temp = index;
    while (temp >= 0) {
      letter = String.fromCharCode((temp % 26) + 65) + letter;
      temp = Math.floor(temp / 26) - 1;
    }
    return letter;
  };

  const data = [
    {
      range: `${sheetName}!${getColLetter(statusColIndex)}${rowNumber}`,
      values: [['완료']],
    }
  ];

  if (endColIndex !== -1) {
    const now = new Date();
    const pad = (n) => n.toString().padStart(2, '0');
    const timeStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    data.push({
      range: `${sheetName}!${getColLetter(endColIndex)}${rowNumber}`,
      values: [[timeStr]],
    });
  }

  await sheetsApi.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: data,
    },
  });
}

/**
 * Marks the specified row as "진행중" in the "포스트 완료여부" column.
 * 
 * @param {string} spreadsheetId 
 * @param {string} sheetName 
 * @param {number} rowNumber 
 * @returns {Promise<void>}
 */
async function markRowAsInProgress(spreadsheetId, sheetName, rowNumber) {
  if (!sheetsApi) throw new Error('Google Sheets API is not initialized. Call initAuth() first.');

  const headerResponse = await sheetsApi.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!1:1`,
  });

  const findColIndex = (headers, possibleNames) => {
    return headers.findIndex(h => {
      if (!h) return false;
      const normalized = String(h).replace(/\s+/g, '');
      return possibleNames.some(p => normalized.includes(p.replace(/\s+/g, '')));
    });
  };

  const headers = headerResponse.data.values[0];
  const statusColIndex = findColIndex(headers, ['포스트 완료여부', '완료여부']);
  const startColIndex = findColIndex(headers, ['시작시간', '시작 시간']);
  if (statusColIndex === -1) throw new Error('Sheet is missing "포스트 완료여부" column.');

  const getColLetter = (index) => {
    let letter = '';
    let temp = index;
    while (temp >= 0) {
      letter = String.fromCharCode((temp % 26) + 65) + letter;
      temp = Math.floor(temp / 26) - 1;
    }
    return letter;
  };

  const data = [
    {
      range: `${sheetName}!${getColLetter(statusColIndex)}${rowNumber}`,
      values: [['진행중']],
    }
  ];

  if (startColIndex !== -1) {
    const now = new Date();
    const pad = (n) => n.toString().padStart(2, '0');
    const timeStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    data.push({
      range: `${sheetName}!${getColLetter(startColIndex)}${rowNumber}`,
      values: [[timeStr]],
    });
  }

  await sheetsApi.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: data,
    },
  });
}

/**
 * Appends rows to the specified sheet.
 * 
 * @param {string} spreadsheetId 
 * @param {string} sheetName 
 * @param {Array<Array<any>>} values 
 * @returns {Promise<void>}
 */
async function appendRows(spreadsheetId, sheetName, values) {
  if (!sheetsApi) throw new Error('Google Sheets API is not initialized. Call initAuth() first.');

  await sheetsApi.spreadsheets.values.append({
    spreadsheetId,
    range: sheetName,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: values,
    },
  });
}

/**
 * Gets the sheet name corresponding to a given gid.
 * 
 * @param {string} spreadsheetId 
 * @param {number|string} gid 
 * @returns {Promise<string|null>}
 */
async function getSheetNameByGid(spreadsheetId, gid) {
  if (!sheetsApi) throw new Error('Google Sheets API is not initialized. Call initAuth() first.');

  const targetGid = Number(gid);
  const response = await sheetsApi.spreadsheets.get({
    spreadsheetId,
  });

  const sheets = response.data.sheets;
  if (!sheets) return null;

  for (const sheet of sheets) {
    if (sheet.properties && sheet.properties.sheetId === targetGid) {
      return sheet.properties.title;
    }
  }

  return null;
}

/**
 * Gets the next sequence number for the "번호" column.
 * It reads Column B and finds the maximum numeric value.
 *
 * @param {string} spreadsheetId 
 * @param {string} sheetName 
 * @returns {Promise<number>}
 */
async function getNextSequenceNumber(spreadsheetId, sheetName) {
  if (!sheetsApi) throw new Error('Google Sheets API is not initialized. Call initAuth() first.');

  const response = await sheetsApi.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!B:B`,
  });

  const rows = response.data.values;
  if (!rows || rows.length <= 1) {
    return 1; // Header only or empty
  }

  let maxNum = 0;
  for (let i = 1; i < rows.length; i++) {
    const val = Number(rows[i][0]);
    if (!isNaN(val) && val > maxNum) {
      maxNum = val;
    }
  }

  return maxNum + 1;
}

module.exports = {
  initAuth,
  fetchNextPendingRow,
  markRowAsCompleted,
  markRowAsInProgress,
  appendRows,
  getSheetNameByGid,
  getNextSequenceNumber,
};
