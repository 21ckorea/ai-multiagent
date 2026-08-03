'use strict';

const fs = require('fs');
const path = require('path');
const googleSheetsHelper = require('../lib/google_sheets');

// WRITABLE_ROOT: 패키지 앱은 APP_DATA_DIR(userData), 개발 환경은 프로젝트 루트
const WRITABLE_ROOT = process.env.APP_DATA_DIR
  ? path.resolve(process.env.APP_DATA_DIR)
  : path.resolve(__dirname, '../..');

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
  let credentialsPath = path.resolve(WRITABLE_ROOT, 'credentials', 'google_service_account.json');
  if (params.credentialPath) {
    credentialsPath = path.resolve(WRITABLE_ROOT, params.credentialPath);
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
        rowNumber:  result.rowNumber,
        title:      result.title,
        account:    result.account    || '',
        blogId:     result.blogId     || '',
        naverId:    result.naverId    || '',
        blogAlias:  result.blogAlias  || '',
        message: '추출 완료. 상태를 "진행중"으로 변경했습니다.',
      });
    } else if (action === 'append') {
      // ── 제목 일괄 추가 액션 ──────────────────────────────────────
      // Gemini 가 생성한 JSON 배열을 받아 시트에 행을 추가합니다.
      // 데이터 우선순위: params.rows > params.data > prev_output(컨텍스트)
      options?.log?.('구글 시트에 제목 데이터 추가 중...');

      let rows = params.rows || params.data;

      // params 에 없으면 직전 스텝 출력(prev_output)에서 JSON 배열 파싱
      if (!rows) {
        const raw = options?.context?.prev_output || '';
        const jsonMatch = raw.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          try { rows = JSON.parse(jsonMatch[0]); } catch(e) {}
        }
      }

      if (typeof rows === 'string') {
        try { rows = JSON.parse(rows); } catch(e) {}
      }

      if (!Array.isArray(rows) || rows.length === 0) {
        return '[ERROR] 추가할 데이터가 없습니다. 직전 스텝 출력이 JSON 배열인지 확인해주세요.';
      }

      // JSON 객체 → 시트 행 변환 (컬럼 순서: A=추출일시, B=번호, C=카테고리, D=제목, E=blogId, F=naverId, G=blogAlias)
      const sheetRows = rows.map(item => [
        item['추출일시']               || '',
        item['번호']                   || '',
        item['주요 분야 / 카테고리']   || item['카테고리'] || '',
        item['추천블로그포스팅제목']   || item['제목']     || '',
        item['blogId']                 || '',
        item['naverId']                || '',
        item['blogAlias']              || '',
      ]);

      options?.log?.(`총 ${sheetRows.length}개 행을 추가합니다...`);
      options?.log?.(`[디버그] spreadsheetId: ${spreadsheetId}`);
      options?.log?.(`[디버그] sheetName: ${sheetName}`);
      options?.log?.(`[디버그] credentialsPath: ${credentialsPath}`);
      try {
        await googleSheetsHelper.appendRows(spreadsheetId, sheetName, sheetRows, credentialsPath);
        options?.log?.(`✅ ${sheetRows.length}개 행 추가 완료!`);
      } catch (appendErr) {
        options?.log?.(`[디버그] appendRows 에러: ${appendErr.message}`);
        options?.log?.(`[디버그] 에러 코드: ${appendErr.code || appendErr.status}`);
        throw appendErr;
      }

      return JSON.stringify({
        success: true,
        message: `${sheetRows.length}개 제목이 구글 시트에 추가되었습니다.`,
        count:   sheetRows.length,
      });
    } else if (action === 'complete') {
      let rowNumber = params.rowNumber;

      // params에서 직접 못 찾으면 context 전체를 뒤져서 rowNumber 추출
      if (!rowNumber && options?.context) {
        for (const val of Object.values(options.context)) {
          if (typeof val === 'string') {
            try {
              const parsed = JSON.parse(val);
              if (parsed && parsed.rowNumber) {
                rowNumber = parsed.rowNumber;
                break;
              }
            } catch(e) {}
          }
        }
      }

      // JSON 문자열로 들어온 경우 파싱
      if (typeof rowNumber === 'string') {
        try {
          const parsed = JSON.parse(rowNumber);
          if (parsed && parsed.rowNumber) rowNumber = parsed.rowNumber;
        } catch(e) {}
      }

      rowNumber = parseInt(rowNumber, 10);
      if (!rowNumber) return '[ERROR] 완료 처리할 rowNumber가 제공되지 않았습니다.';
      
      options?.log?.(`포스트 결과 업데이트 중 (Row ${rowNumber})...`);
      if (typeof googleSheetsHelper.markRowAsCompleted === 'function') {
        await googleSheetsHelper.markRowAsCompleted(spreadsheetId, sheetName, rowNumber);
      }

      // 완료 처리 후 다음 대기 행이 있는지 확인
      options?.log?.('다음 대기 행 확인 중...');
      const nextRow = await googleSheetsHelper.fetchNextPendingRow(spreadsheetId, sheetName);
      if (nextRow) {
        options?.log?.(`✅ 다음 대기 항목 있음: "${nextRow.title}" (Row ${nextRow.rowNumber})`);
      } else {
        options?.log?.('🏁 더 이상 대기 중인 항목이 없습니다. 루프를 종료합니다.');
      }

      return JSON.stringify({
        success: true,
        message: '완료 처리 및 시간 업데이트 성공',
        hasNext: !!nextRow,
        nextTitle: nextRow?.title || '',
        nextRowNumber: nextRow?.rowNumber || null,
      });
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
