'use strict';

const fs = require('fs');
const path = require('path');
const googleSheetsHelper = require('../../references/google_sheets');

/**
 * Google Sheet Agent
 * 
 * @param {string} prompt - JSON format instructions.
 * @param {object} options - Options object.
 * @returns {Promise<string>}
 */
async function execute(prompt, options) {
  options?.log?.('Google Sheet API 연동 준비...');
  
  let params = {};
  try {
    const promptToParse = options?.rawPrompt || prompt;
    const jsonMatch = promptToParse.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      params = JSON.parse(jsonMatch[0]);
      
      if (options?.context) {
        for (const [key, val] of Object.entries(params)) {
          if (typeof val === 'string') {
            const match = val.match(/^\{\{(.+)\}\}$/);
            if (match && options.context[match[1]]) {
              params[key] = options.context[match[1]];
            }
          }
        }
      }
    }
  } catch (e) {
    params = {};
  }

  // Credentials path (우선순위: 프롬프트에서 전달된 경로 > 기본 경로)
  let credentialsPath = path.resolve(process.cwd(), 'credentials', 'google_service_account.json');
  if (params.credentialPath) {
    credentialsPath = path.resolve(process.cwd(), params.credentialPath);
  }
  
  if (!fs.existsSync(credentialsPath)) {
    return `[ERROR] Google Service Account 인증 파일이 없습니다. (${credentialsPath})`;
  }

  try {
    googleSheetsHelper.initAuth(credentialsPath);
  } catch (err) {
    return `[ERROR] 구글 시트 인증 실패: ${err.message}`;
  }

  const action = params.action || 'fetch';  
  const spreadsheetId = params.spreadsheetId;
  const sheetName = params.sheetName || '시트1';
  let rowNumber = params.rowNumber;

  if (typeof rowNumber === 'string') {
    try {
      const obj = JSON.parse(rowNumber);
      if (obj.rowNumber) rowNumber = obj.rowNumber;
    } catch(e) {}
  }

  if (!spreadsheetId) {
    return '[ERROR] spreadsheetId가 프롬프트에 없습니다.';
  }

  try {
    if (action === 'fetch') {
      options?.log?.('대기 중인 포스팅 주제 검색 중...');
      const result = await googleSheetsHelper.fetchNextPendingRow(spreadsheetId, sheetName);
      if (!result) {
        return `[ERROR] 진행 대기 중인(포스트 완료여부가 비어있는) 항목이 없습니다.`;
      }
      
      options?.log?.(`추출 완료: "${result.title}" (Row ${result.rowNumber}). 진행중 마킹 처리 중...`);
      // markRowAsInProgress requires spreadsheetId, sheetName, rowNumber
      if (typeof googleSheetsHelper.markRowAsInProgress === 'function') {
        await googleSheetsHelper.markRowAsInProgress(spreadsheetId, sheetName, result.rowNumber);
      }
      
      return JSON.stringify({
        rowNumber: result.rowNumber,
        title: result.title,
        account: result.account || '',
        message: '추출 완료. 상태를 "진행중"으로 변경했습니다.',
      });
    } else if (action === 'complete') {
      let rowNumber = params.rowNumber;
      try {
        const parsed = JSON.parse(rowNumber);
        if (parsed && parsed.rowNumber) rowNumber = parsed.rowNumber;
      } catch(e) {}
      
      rowNumber = parseInt(rowNumber, 10);
      if (!rowNumber) return '[ERROR] 완료 처리할 rowNumber가 제공되지 않았습니다.';
      
      options?.log?.(`포스트 결과 업데이트 중 (Row ${rowNumber})...`);
      if (typeof googleSheetsHelper.markRowAsCompleted === 'function') {
        await googleSheetsHelper.markRowAsCompleted(spreadsheetId, sheetName, rowNumber);
      }
      return JSON.stringify({ success: true, message: '완료 처리 및 시간 업데이트 성공' });
    } else {
      return `[ERROR] 알 수 없는 동작: ${action}`;
    }
  } catch (err) {
    return `[ERROR] 구글 시트 연동 실패: ${err.message}`;
  }
}

module.exports = {
  execute,
};
