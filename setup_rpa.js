const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const stepsFile = path.resolve(__dirname, 'data/workflows/steps.json');
const workflowsFile = path.resolve(__dirname, 'data/workflows/workflows.json');

const naverPromptRaw = fs.readFileSync(path.resolve(__dirname, 'references/prompts/gemini-naver-template.txt'), 'utf8');
const imageStyleRaw = fs.readFileSync(path.resolve(__dirname, 'references/prompts/gemini-image-style.txt'), 'utf8');

// remove header
const naverPrompt = naverPromptRaw.split('================================================================================')[2].trim();
const imageStyle = imageStyleRaw.split('================================================================================')[2].trim();

const steps = JSON.parse(fs.readFileSync(stepsFile, 'utf8'));

// Create 5 new steps
const step1 = {
  id: `step_${uuidv4().slice(0, 8)}`,
  type: 'plugin_google_sheet',
  name: '1. 시트에서 주제 추출',
  prompt: '{\n  "action": "fetch",\n  "spreadsheetId": "YOUR_SPREADSHEET_ID_HERE",\n  "sheetName": "시트1"\n}',
  newChat: true, timeout: 60000,
  loop: { enabled: false }
};

const step2 = {
  id: `step_${uuidv4().slice(0, 8)}`,
  type: 'gemini',
  name: '2. 블로그 글 작성',
  prompt: naverPrompt.replace('{{TOPIC}}', '{{prev_output}}').replace('{{BLOG_ALIAS}}', '라이언'),
  newChat: true, timeout: 180000,
  loop: { enabled: false }
};

const step3 = {
  id: `step_${uuidv4().slice(0, 8)}`,
  type: 'plugin_gemini_image',
  name: '3. 블로그 썸네일/이미지 생성',
  prompt: `{\n  "text": "{{prev_output}}",\n  "style": "${imageStyle.replace(/\n/g, ' ').replace(/"/g, '\\"')}"\n}`,
  newChat: true, timeout: 180000,
  loop: { enabled: false }
};

const step4 = {
  id: `step_${uuidv4().slice(0, 8)}`,
  type: 'plugin_naver_publish',
  name: '4. 네이버 자동 포스팅',
  prompt: '{\n  "title": "{{step_' + step1.id.replace('step_','') + '_output}}",\n  "content": "{{step_' + step2.id.replace('step_','') + '_output}}",\n  "images": "{{prev_output}}"\n}',
  newChat: true, timeout: 300000,
  loop: { enabled: false }
};

const step5 = {
  id: `step_${uuidv4().slice(0, 8)}`,
  type: 'plugin_google_sheet',
  name: '5. 시트 완료 처리',
  prompt: '{\n  "action": "complete",\n  "spreadsheetId": "YOUR_SPREADSHEET_ID_HERE",\n  "sheetName": "시트1",\n  "rowNumber": "{{step_' + step1.id.replace('step_','') + '_output}}"\n}',
  newChat: true, timeout: 60000,
  loop: { enabled: false }
};

steps.push(step1, step2, step3, step4, step5);
fs.writeFileSync(stepsFile, JSON.stringify(steps, null, 2));

const workflows = JSON.parse(fs.readFileSync(workflowsFile, 'utf8'));
const wf = {
  id: `wf_${uuidv4().slice(0, 8)}`,
  name: '네이버 블로그 자동 포스팅 파이프라인',
  description: '구글 시트 -> 블로그 글 작성 -> 네이버 업로드',
  steps: [step1.id, step2.id, step3.id, step4.id, step5.id],
  input: '블로그 자동화 시작',
};
workflows.push(wf);
fs.writeFileSync(workflowsFile, JSON.stringify(workflows, null, 2));

console.log('RPA steps created!');
