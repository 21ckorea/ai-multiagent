'use strict';

/**
 * @file server.js
 * @description Express API 서버 — 워크플로우/세션/실행 REST API + SSE
 */

// === ASAR 앱 배포 환경을 위한 CWD 패치 ===
if (process.env.APP_DATA_DIR) {
  try {
    process.chdir(process.env.APP_DATA_DIR);
    console.log('[Server] process.cwd() changed to:', process.cwd());
  } catch (err) {
    console.error('[Server] Failed to change directory to APP_DATA_DIR:', err);
  }
}

const express        = require('express');
const path           = require('path');
const fs             = require('fs');
const { execSync }   = require('child_process');
const multer         = require('multer');
const { v4: uuidv4 } = require('uuid');

const sessionManager = require('../agent/session_manager');
const geminiAgent    = require('../agent/gemini_agent');
const store          = require('../storage/workflow_store');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── 멀터(Multer) 업로드 설정 ───────────────────────────────────
const uploadDir = path.join(process.cwd(), 'credentials');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    // 임의의 파일명으로 인한 덮어쓰기나 보안 문제 방지를 위해 고유 이름 부여
    cb(null, `cred_${uuidv4().slice(0, 8)}.json`);
  }
});
const upload = multer({ storage });

// ─── 시작 전 포트 자동 정리 ─────────────────────────────────
try {
  // Mac / Linux: lsof 기반 포트 정리
  execSync(`lsof -ti:${PORT} | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore' });
} catch { /* Windows 등 환경에서 lsof 미존재 시 무시 */ }

// ─── SSE 클라이언트 관리 ─────────────────────────────────────────
const sseClients = new Set();
let runAbortRequested = false;

function sendSSE(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

// ─── 미들웨어 ────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'ui')));

// ─── 파일 업로드 API ─────────────────────────────────────────────
app.post('/api/upload-credentials', upload.single('credentialFile'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: '파일이 업로드되지 않았습니다.' });
  }
  // 상대 경로 반환 (예: 'credentials/cred_a1b2c3d4.json')
  const relativePath = path.join('credentials', req.file.filename);
  res.json({ ok: true, path: relativePath });
});

// ─── 세션 API ────────────────────────────────────────────────────

app.get('/api/session', (req, res) => {
  const info  = sessionManager.getSessionInfo();
  const state = sessionManager.getBrowserState();
  res.json({ ok: true, info, browserState: state });
});

app.post('/api/session/start', async (req, res) => {
  try {
    const result = await sessionManager.startSession();
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/session/verify', async (req, res) => {
  try {
    const result = await sessionManager.verifyAndSaveSession();
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/session/clear', async (req, res) => {
  try {
    const { clearProfile } = req.body || {};
    const result = await sessionManager.clearSession(!!clearProfile);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── 워크플로우 CRUD ─────────────────────────────────────────────

app.get('/api/workflows', (req, res) => {
  res.json(store.getAllWorkflows());
});

app.post('/api/workflows', (req, res) => {
  res.json(store.createWorkflow(req.body));
});

app.get('/api/workflows/:id', (req, res) => {
  const wf = store.getWorkflow(req.params.id);
  if (!wf) return res.status(404).json({ error: 'not found' });
  res.json(wf);
});

app.put('/api/workflows/:id', (req, res) => {
  const wf = store.updateWorkflow(req.params.id, req.body);
  if (!wf) return res.status(404).json({ error: 'not found' });
  res.json(wf);
});

app.delete('/api/workflows/:id', (req, res) => {
  store.deleteWorkflow(req.params.id);
  res.json({ ok: true });
});

// ─── 스텝 CRUD ───────────────────────────────────────────────────

app.get('/api/steps', (req, res) => {
  res.json(store.getAllSteps());
});

app.post('/api/steps', (req, res) => {
  res.json(store.createStep(req.body));
});

app.get('/api/steps/:id', (req, res) => {
  const step = store.getStep(req.params.id);
  if (!step) return res.status(404).json({ error: 'not found' });
  res.json(step);
});

app.put('/api/steps/:id', (req, res) => {
  const step = store.updateStep(req.params.id, req.body);
  if (!step) return res.status(404).json({ error: 'not found' });
  res.json(step);
});

app.delete('/api/steps/:id', (req, res) => {
  store.deleteStep(req.params.id);
  res.json({ ok: true });
});

// ─── 내보내기 & 가져오기 API ──────────────────────────────────────

app.get('/api/export', (req, res) => {
  try {
    const data = store.exportData();
    res.json(data);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/import', express.json({ limit: '50mb' }), (req, res) => {
  try {
    const result = store.importData(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── 실행 API ────────────────────────────────────────────────────

/** SSE 이벤트 스트림 */
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  res.write('data: {"type":"connected"}\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

/** 워크플로우 실행 */
app.post('/api/run', async (req, res) => {
  const { workflowId, input } = req.body || {};
  const wf = store.getWorkflow(workflowId);
  if (!wf) return res.status(404).json({ error: 'workflow not found' });

  runAbortRequested = false;
  res.json({ ok: true, message: '실행 시작' });

  // 비동기 실행 (응답 먼저 보낸 후 실행)
  runWorkflow(wf, input || '').catch((err) => {
    sendSSE({ type: 'error', message: err.message });
  });
});

/** 실행 중단 */
app.post('/api/abort', (req, res) => {
  runAbortRequested = true;
  sendSSE({ type: 'aborted', message: '사용자가 중단 요청했습니다.' });
  res.json({ ok: true });
});

// ─── 워크플로우 실행 엔진 ────────────────────────────────────────

async function runWorkflow(workflow, initialInput) {
  const steps = workflow.steps
    .map((id) => store.getStep(id))
    .filter(Boolean);

  // 파이프라인 컨텍스트 (변수 치환용)
  const context = {
    workflow_input: initialInput,
    prev_output:   initialInput,
    today:         new Date().toISOString().slice(0, 10),
  };

  sendSSE({
    type:         'workflow_start',
    workflowId:   workflow.id,
    workflowName: workflow.name,
    totalSteps:   steps.length,
  });

  // 무한 루프 방지를 위한 최대 실행 스텝 수
  const MAX_WORKFLOW_STEPS = 30;
  let executionCount = 0;
  let currentIndex = 0;
  const stepExecutionCounts = {};

  while (currentIndex < steps.length) {
    if (runAbortRequested) {
      sendSSE({ type: 'aborted', message: '실행이 중단되었습니다.' });
      return;
    }

    if (executionCount >= MAX_WORKFLOW_STEPS) {
      sendSSE({ type: 'error', message: `최대 순환 횟수(${MAX_WORKFLOW_STEPS}회)를 초과하여 강제 종료되었습니다.` });
      break;
    }
    executionCount++;

    const step = steps[currentIndex];
    stepExecutionCounts[step.id] = (stepExecutionCounts[step.id] || 0) + 1;

    // ── 변수 치환 ──────────────────────────────────────────────────
    // {{prev_output}}, {{workflow_input}}, {{step_XXX_output}} 등 치환
    const resolvedPrompt = substituteVariables(step.prompt, context);

    // ── 단계 시작 알림 ─────────────────────────────────────────────
    sendSSE({
      type:       'step_start',
      stepId:     step.id,
      stepName:   step.name,
      stepIndex:  currentIndex + 1,
      totalSteps: steps.length,
    });

    // ── 질의 프롬프트 로그 (전문 전송) ────────────────────────────
    sendSSE({
      type:     'step_prompt',
      stepId:   step.id,
      stepName: step.name,
      prompt:   resolvedPrompt,
    });

    let output    = '';
    let loopCount = 0;
    let gotoTriggered = false;
    const maxRetries = step.loop?.enabled ? (step.loop.maxRetries || 3) : 1;

    // ── 루프 실행 ─────────────────────────────────────────────────
    while (loopCount < maxRetries) {
      if (runAbortRequested) break;
      loopCount++;

      if (loopCount > 1) {
        sendSSE({
          type:    'step_log',
          stepId:  step.id,
          message: `🔁 루프 재시도 ${loopCount}/${maxRetries}회 시작...`,
        });
      }

      try {
        // ── 실제 Agent 호출 ──────────────────────────────────────
        if (!step.type || step.type === 'gemini') {
          output = await geminiAgent.askGemini(resolvedPrompt, {
            newChat: step.newChat !== false,
            headless: step.headless !== false,
            log: (msg) => sendSSE({ type: 'step_log', stepId: step.id, message: msg }),
            context
          });
        } else if (step.type === 'plugin_google_sheet') {
          const googleSheetAgent = require('../agent/google_sheet_agent');
          output = await googleSheetAgent.execute(resolvedPrompt, {
            log: (msg) => sendSSE({ type: 'step_log', stepId: step.id, message: msg }),
            context,
            rawPrompt: step.prompt
          });
        } else if (step.type === 'plugin_gemini_image') {
          const geminiImageAgent = require('../agent/gemini_image_agent');
          output = await geminiImageAgent.execute(step.prompt, {
            headless: step.headless !== false,
            log: (msg) => sendSSE({ type: 'step_log', stepId: step.id, message: msg }),
            context,
            rawPrompt: step.prompt
          });
        } else if (step.type === 'plugin_naver_publish') {
          const naverBlogAgent = require('../agent/naver_blog_agent');
          output = await naverBlogAgent.execute(step.prompt, { // 파싱 오류 방지를 위해 원본 prompt도 전달 가능하지만 하위호환을 위해 resolvedPrompt 유지. 대신 플러그인에서 context 활용
            log: (msg) => sendSSE({ type: 'step_log', stepId: step.id, message: msg }),
            context,
            rawPrompt: step.prompt
          });
        } else {
          output = `[ERROR] 알 수 없는 스텝 타입: ${step.type}`;
        }

        // ── 루프 및 Goto 조건 평가 ────────────────────────────────
        const conditionMet = !step.loop?.enabled || evaluateLoopCondition(step.loop, output);

        if (step.loop?.enabled && !conditionMet) {
          if (step.loop.gotoStepId) {
            // Goto 스텝이 있는 경우
            const targetIndex = steps.findIndex((s) => s.id === step.loop.gotoStepId);
            const maxGotoRetries = step.loop.maxRetries || 3;
            
            // 현재 스텝이 (초기 1회 + 최대 재시도 횟수) 이내로 실행되었을 때만 Goto 허용
            if (targetIndex !== -1 && stepExecutionCounts[step.id] <= maxGotoRetries) {
              sendSSE({ type: 'step_log', stepId: step.id, message: `루프 조건 미충족 — 스텝 되돌아가기 (Goto: ${step.loop.gotoStepId}, 남은 재시도: ${maxGotoRetries - stepExecutionCounts[step.id] + 1})` });
              
              // 피드백 전송을 위해 컨텍스트 업데이트 후 탈출
              context[`${step.id}_output`] = output;
              context.prev_output          = output;
              
              // step_done 전송 (이 스텝은 여기서 종료)
              sendSSE({
                type:      'step_done',
                stepId:    step.id,
                stepName:  step.name,
                output,
                loopCount,
              });
              
              currentIndex = targetIndex;
              gotoTriggered = true;
              break; // 내부 while (loopCount < maxRetries) 탈출
            } else if (targetIndex !== -1) {
              sendSSE({ type: 'step_log', stepId: step.id, message: `최대 재시도 횟수(${maxGotoRetries}회) 초과 — 스텝 되돌아가기를 중단하고 다음 단계로 넘어갑니다.` });
              break; // 내부 while을 탈출하여 다음 스텝으로 진행
            }
          } else {
            // 기존의 자가 반복(Self Loop) 로직
            if (loopCount < maxRetries) {
              const delay = step.loop.retryDelayMs || 2000;
              sendSSE({ type: 'step_log', stepId: step.id, message: `루프 조건 미충족 — ${delay}ms 후 재시도` });
              await sleep(delay);
            }
          }
        } else if (step.loop?.enabled && conditionMet) {
          sendSSE({ type: 'step_log', stepId: step.id, message: '✓ 루프 종료 조건 충족 (PASS)' });
        }

        if (conditionMet) break; // 루프 탈출 (다음 스텝으로)

      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        sendSSE({ type: 'step_error', stepId: step.id, stepName: step.name, error: errMsg });
        output = `[ERROR] ${errMsg}`;
        break;
      }
    }

    if (gotoTriggered) {
      continue; // 다음 스텝으로 진행하지 않고 바뀐 currentIndex 위치부터 새로 while 루프 시작
    }

    // ── 파이프 컨텍스트 업데이트 ──────────────────────────────────
    context[`${step.id}_output`] = output;
    context.prev_output          = output;

    // ── 단계 완료: 응답 전문 포함해서 전송 ────────────────────────
    sendSSE({
      type:      'step_done',
      stepId:    step.id,
      stepName:  step.name,
      output,
      loopCount,
    });
    
    currentIndex++;
  }


  // ── 워크플로우 완료 ───────────────────────────────────────────
  sendSSE({
    type:         'workflow_done',
    finalOutput:  context.prev_output,
    workflowId:   workflow.id,
    workflowName: workflow.name,
  });
}

// ─── 헬퍼 함수 ───────────────────────────────────────────────────

/**
 * 프롬프트 내 {{변수}} 치환
 * - {{prev_output}}, {{workflow_input}}, {{today}}
 * - {{step_XXXXXXXX_output}} 형태 step-ID 참조도 지원
 */
function substituteVariables(prompt, context) {
  return prompt.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
    const trimmed = key.trim();
    return Object.prototype.hasOwnProperty.call(context, trimmed)
      ? context[trimmed]
      : `{{${trimmed}}}`;
  });
}

function evaluateLoopCondition(loop, output) {
  if (!loop || loop.condition === 'none') return true;
  if (loop.condition === 'keyword')
    return output.includes(loop.conditionValue || '');
  if (loop.condition === 'minLength')
    return output.length >= parseInt(loop.conditionValue || '0', 10);
  if (loop.condition === 'regex') {
    try { return new RegExp(loop.conditionValue).test(output); } catch { return false; }
  }
  return true;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── 서버 시작 ────────────────────────────────────────────────────

const server = app.listen(PORT, () => {
  console.log(`\n🚀 AI Multiagent 서버 실행 중: http://localhost:${PORT}`);
  console.log(`   UI 접속: http://localhost:${PORT}\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ 포트 ${PORT}가 이미 사용 중입니다.`);
    console.error(`   터미널에서 다음 명령으로 종료: lsof -ti:${PORT} | xargs kill -9\n`);
    process.exit(1);
  } else {
    console.error('서버 에러:', err);
    process.exit(1);
  }
});

module.exports = app;
