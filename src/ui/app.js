'use strict';

/* ════════════════════════════════════════════════════════
   AI Multiagent — 프론트엔드 앱 로직
════════════════════════════════════════════════════════ */

// ─── 상태 ───────────────────────────────────────────────────
const State = {
  activeTab: 'session',
  steps: [],
  workflows: [],
  selectedStepId: null,
  selectedWorkflowId: null,
  currentWorkflowStepIds: [],
  sessionInfo: null,
  browserOpen: false,
  runStatus: 'idle', // idle | running | done | error
  sseSource: null,
  logLines: [],
  finalResult: '',
};

// ─── 탭 전환 ────────────────────────────────────────────────
function switchTab(tabId) {
  State.activeTab = tabId;
  document.querySelectorAll('.tab-content').forEach((el) => el.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach((el) => el.classList.remove('active'));

  const tabEl = document.getElementById(`tab-${tabId}`);
  const navEl = document.getElementById(`nav-${tabId}`);
  if (tabEl) tabEl.classList.add('active');
  if (navEl) navEl.classList.add('active');

  const titles = {
    session:  ['Gemini 연결', 'Google 계정 연결 및 세션 관리'],
    prompts:  ['프롬프트 관리', '단계별 AI 프롬프트를 작성하고 관리하세요'],
    workflow: ['워크플로우', '스텝을 연결해 자동화 파이프라인을 구성하세요'],
    runner:   ['실행 & 모니터링', '워크플로우를 실행하고 진행 상황을 모니터링하세요'],
  };

  document.getElementById('page-title').textContent = titles[tabId]?.[0] || '';
  document.getElementById('page-desc').textContent  = titles[tabId]?.[1] || '';
}

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    switchTab(tab);
    if (tab === 'prompts') loadSteps();
    if (tab === 'workflow') { loadSteps(); loadWorkflows(); }
    if (tab === 'runner') { loadWorkflowsForRunner(); }
  });
});

// ─── 세션 관리 ──────────────────────────────────────────────

async function loadSessionStatus() {
  try {
    const res = await fetch('/api/session');
    const data = await res.json();

    State.sessionInfo = data.info;
    State.browserOpen = data.browserState?.isOpen || false;

    updateSessionUI(data);
  } catch {
    setSessionMessage('서버 연결 실패', 'error');
  }
}

function updateSessionUI(data) {
  const badge  = document.getElementById('session-status-badge');
  const badgeText = document.getElementById('badge-text');
  const guideSuccess = document.getElementById('guide-success');
  const sessionInfoBox = document.getElementById('session-info-box');
  const sessionMeta = document.getElementById('session-meta');
  const navBadge = document.getElementById('session-badge');

  const btnStart = document.getElementById('btn-start-session');
  const btnVerify = document.getElementById('btn-verify-session');

  const info = data.info;
  const isOpen = data.browserState?.isOpen || false;

  // 상태 배지
  if (info?.loggedIn) {
    badge.classList.add('connected');
    const dt = new Date(info.savedAt).toLocaleString('ko-KR');
    badgeText.textContent = `연결됨 · ${dt}`;
    navBadge.classList.add('visible');
    guideSuccess.style.display = 'flex';

    sessionInfoBox.style.display = 'block';
    sessionMeta.innerHTML = `
      <span>✅ 로그인 확인: ${dt}</span>
      <span>📁 프로필: profiles/gemini-profile</span>
    `;
  } else {
    badge.classList.remove('connected');
    badgeText.textContent = '연결 안됨';
    navBadge.classList.remove('visible');
    guideSuccess.style.display = 'none';
    sessionInfoBox.style.display = 'none';
  }

  // 버튼 상태
  if (isOpen) {
    btnStart.style.display = 'none';
    btnVerify.style.display = 'flex';
  } else {
    btnStart.style.display = 'flex';
    btnVerify.style.display = 'none';
  }

  // 상태 그리드
  document.getElementById('status-browser').textContent = isOpen ? '열림' : '닫힘';
  document.getElementById('status-browser').className = `status-value ${isOpen ? 'ok' : ''}`;

  document.getElementById('status-login').textContent = info?.loggedIn ? '로그인 완료' : '미확인';
  document.getElementById('status-login').className = `status-value ${info?.loggedIn ? 'ok' : ''}`;

  document.getElementById('status-saved').textContent = info?.savedAt
    ? new Date(info.savedAt).toLocaleString('ko-KR') : '없음';
}

async function startSession() {
  setSessionMessage('Gemini 브라우저를 여는 중...', 'loading');
  const btn = document.getElementById('btn-start-session');
  btn.disabled = true;

  try {
    const res = await fetch('/api/session/start', { method: 'POST' });
    const data = await res.json();

    if (data.ok) {
      setSessionMessage('브라우저가 열렸습니다. Google 계정으로 로그인 후 아래 "연결 확인"을 눌러주세요.', 'info');
      State.browserOpen = true;
      document.getElementById('btn-start-session').style.display = 'none';
      document.getElementById('btn-verify-session').style.display = 'flex';
    } else {
      setSessionMessage(`오류: ${data.error || '브라우저 실행 실패'}`, 'error');
      btn.disabled = false;
    }
  } catch (err) {
    setSessionMessage(`오류: ${err.message}`, 'error');
    btn.disabled = false;
  }
}

async function verifySession() {
  setSessionMessage('로그인 상태 확인 중...', 'loading');
  const btn = document.getElementById('btn-verify-session');
  btn.disabled = true;

  try {
    const res = await fetch('/api/session/verify', { method: 'POST' });
    const data = await res.json();

    if (data.ok && data.loggedIn) {
      setSessionMessage('✅ Gemini 연결이 성공적으로 저장되었습니다!', 'success');
      await loadSessionStatus();
    } else {
      setSessionMessage(
        data.error || 'Gemini 로그인이 확인되지 않았습니다. 브라우저에서 Google 계정 로그인을 완료해주세요.',
        'error',
      );
    }
  } catch (err) {
    setSessionMessage(`오류: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function clearSession() {
  if (!confirm('세션 캐시를 삭제하시겠습니까?\n(저장된 로그인 정보가 모두 삭제됩니다)')) return;

  setSessionMessage('세션 삭제 중...', 'loading');

  try {
    const res = await fetch('/api/session/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clearProfile: false }),
    });
    const data = await res.json();

    if (data.ok) {
      setSessionMessage('세션이 삭제되었습니다.', 'info');
      State.browserOpen = false;
      State.sessionInfo = null;
      await loadSessionStatus();
    }
  } catch (err) {
    setSessionMessage(`오류: ${err.message}`, 'error');
  }
}

function setSessionMessage(text, type = 'info') {
  const el = document.getElementById('session-message');
  el.textContent = text;
  el.className = `status-message ${type}`;
}

// ─── 스텝 관리 ──────────────────────────────────────────────

async function loadSteps() {
  try {
    const res = await fetch('/api/steps');
    State.steps = await res.json();
    renderStepsList();
  } catch { /* ignore */ }
}

function renderStepsList() {
  const list = document.getElementById('steps-list');
  if (!State.steps.length) {
    list.innerHTML = '<div class="empty-state">스텝이 없습니다.<br/>위 \'+ 추가\' 버튼으로 생성하세요.</div>';
    return;
  }

  list.innerHTML = State.steps.map((step, i) => `
    <div class="step-item ${step.id === State.selectedStepId ? 'active' : ''}"
         onclick="selectStep('${step.id}')">
      <div class="step-item-num">${i + 1}</div>
      <div class="step-item-name">${escHtml(step.name)}</div>
      ${step.loop?.enabled ? '<span class="step-item-loop">루프</span>' : ''}
    </div>
  `).join('');
}

function selectStep(id) {
  State.selectedStepId = id;
  const step = State.steps.find((s) => s.id === id);
  if (!step) return;

  renderStepsList();
  document.getElementById('editor-empty').style.display = 'none';
  document.getElementById('editor-form').style.display = 'block';

  document.getElementById('step-name').value    = step.name || '';
  const typeSelect = document.getElementById('step-type');
  typeSelect.value = step.type || 'gemini';
  
  // 타입에 따른 업로드 폼 토글
  const uploadGroup = document.getElementById('credential-upload-group');
  uploadGroup.style.display = typeSelect.value === 'plugin_google_sheet' ? 'block' : 'none';
  
  typeSelect.onchange = function() {
    uploadGroup.style.display = this.value === 'plugin_google_sheet' ? 'block' : 'none';
  };
  document.getElementById('step-prompt').value  = step.prompt || '';
  document.getElementById('step-timeout').value = (step.timeout || 120000) / 1000;
  document.getElementById('step-new-chat').checked = step.newChat !== false;

  const loop = step.loop || {};
  document.getElementById('loop-enabled').checked = !!loop.enabled;
  document.getElementById('loop-condition').value  = loop.condition || 'none';
  document.getElementById('loop-value').value      = loop.conditionValue || '';
  document.getElementById('loop-retries').value    = loop.maxRetries || 3;
  
  // Goto 드롭다운 채우기 (현재 스텝 제외 이전 스텝들을 표시하거나, 원한다면 전체 스텝 표시)
  const gotoSelect = document.getElementById('loop-goto-step');
  gotoSelect.innerHTML = '<option value="">(없음) - 현재 스텝만 반복</option>' + 
    State.steps.filter(s => s.id !== id).map(s => `<option value="${s.id}">${escHtml(s.name)}</option>`).join('');
  gotoSelect.value = loop.gotoStepId || '';

  toggleLoop(document.getElementById('loop-enabled'));

  // ── 스텝 ID 표시 ───────────────────────────────────────────
  const idDisplay = document.getElementById('step-id-display');
  const varStr = `{{${id}_output}}`;
  idDisplay.innerHTML = `
    <span class="id-label">스텝 ID:</span>
    <span class="id-value" onclick="navigator.clipboard.writeText('${id}').then(() => showToast('ID 복사 완료'))" title="클릭하면 ID를 복사합니다">${id}</span>
    <span class="id-copy-hint">• 다른 스텝에서 참조: <code>${escHtml(varStr)}</code></span>
  `;

  // ── 이전 스텝 변수 팔레트 렌더링 ──────────────────────
  renderStepVarPalette(id);
}

async function createStep() {
  try {
    const res = await fetch('/api/steps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'gemini', name: '새 스텝', prompt: '' }),
    });
    const step = await res.json();
    await loadSteps();
    selectStep(step.id);
  } catch { /* ignore */ }
}

/**
 * 현재 선택된 스텝보다 앞에 있는 스텝들의 변수 카드를 렌더링
 */
function renderStepVarPalette(currentStepId) {
  const currentIdx = State.steps.findIndex((s) => s.id === currentStepId);
  const prevSteps  = currentIdx > 0 ? State.steps.slice(0, currentIdx) : [];

  const group    = document.getElementById('var-group-steps');
  const chipsEl  = document.getElementById('var-chips-steps');

  if (!prevSteps.length) {
    group.style.display = 'none';
    return;
  }

  group.style.display = 'block';
  chipsEl.innerHTML = prevSteps.map((step, i) => {
    const varToken = `{{${step.id}_output}}`;
    const isImmediate = i === prevSteps.length - 1; // 바로 직전 스텝
    return `
      <button class="var-chip step-ref" onclick="insertVar('${varToken}')" title="${escHtml(step.name)} 스텝의 출력 추삽">
        <span class="var-chip-icon">${isImmediate ? '⬆' : '🔗'}</span>
        <span>${escHtml(varToken)}</span>
        <span class="var-chip-desc">${escHtml(step.name)}${isImmediate ? ' (직전)' : ''}</span>
      </button>
    `;
  }).join('');
}

/**
 * 프롬프트 텍스트에어 코시 위치에 변수 삽입
 */
function insertVar(varToken) {
  const textarea = document.getElementById('step-prompt');
  if (!textarea) return;

  textarea.focus();
  const start = textarea.selectionStart;
  const end   = textarea.selectionEnd;
  const before = textarea.value.slice(0, start);
  const after  = textarea.value.slice(end);

  textarea.value = before + varToken + after;

  // 커서를 삽입 후 위치로
  const pos = start + varToken.length;
  textarea.setSelectionRange(pos, pos);
  textarea.focus();

  showToast(`${varToken} 삽입 완료`);
}

async function saveStep() {
  if (!State.selectedStepId) return;

  const loopEnabled = document.getElementById('loop-enabled').checked;

  const data = {
    name: document.getElementById('step-name').value,
    type: document.getElementById('step-type').value,
    prompt: document.getElementById('step-prompt').value,
    timeout: parseInt(document.getElementById('step-timeout').value, 10) * 1000,
    newChat: document.getElementById('step-new-chat').checked,
    loop: {
      enabled: loopEnabled,
      condition: document.getElementById('loop-condition').value,
      conditionValue: document.getElementById('loop-value').value,
      maxRetries: parseInt(document.getElementById('loop-retries').value, 10),
      retryDelayMs: 2000,
      gotoStepId: document.getElementById('loop-goto-step').value || '',
    },
  };

  try {
    await fetch(`/api/steps/${State.selectedStepId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    await loadSteps();
    showToast('스텝이 저장되었습니다.');
  } catch { /* ignore */ }
}

/**
 * 자격 증명(JSON) 파일 업로드 처리
 */
async function uploadCredentialFile() {
  const fileInput = document.getElementById('credential-file-input');
  if (!fileInput.files || fileInput.files.length === 0) {
    showToast('업로드할 파일을 선택해주세요.', 'error');
    return;
  }

  const formData = new FormData();
  formData.append('credentialFile', fileInput.files[0]);

  const statusEl = document.getElementById('credential-upload-status');
  statusEl.textContent = '업로드 중...';
  statusEl.style.color = 'blue';

  try {
    const res = await fetch('/api/upload-credentials', {
      method: 'POST',
      body: formData
    });
    const data = await res.json();
    
    if (data.ok) {
      statusEl.textContent = '✅ 업로드 완료! 프롬프트에 credentialPath가 자동 삽입되었습니다.';
      statusEl.style.color = 'green';
      
      // JSON 프롬프트라면 파싱해서 credentialPath 추가
      const promptEl = document.getElementById('step-prompt');
      let promptVal = promptEl.value;
      try {
        const jsonMatch = promptVal.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          parsed.credentialPath = data.path;
          promptEl.value = JSON.stringify(parsed, null, 2);
        } else {
          // JSON이 아니면 그냥 붙여넣기
          promptEl.value += `\n\n// 인증 파일 경로\n{"credentialPath": "${data.path}"}`;
        }
      } catch (e) {
        promptEl.value += `\n\n// 인증 파일 경로\n{"credentialPath": "${data.path}"}`;
      }
      
      saveStep(); // 자동 저장
    } else {
      statusEl.textContent = `❌ 업로드 실패: ${data.error}`;
      statusEl.style.color = 'red';
    }
  } catch (err) {
    statusEl.textContent = `❌ 업로드 오류: ${err.message}`;
    statusEl.style.color = 'red';
  }
}

async function deleteCurrentStep() {
  if (!State.selectedStepId) return;
  if (!confirm('이 스텝을 삭제하시겠습니까?')) return;

  try {
    await fetch(`/api/steps/${State.selectedStepId}`, { method: 'DELETE' });
    State.selectedStepId = null;
    document.getElementById('editor-empty').style.display = 'flex';
    document.getElementById('editor-form').style.display = 'none';
    await loadSteps();
  } catch { /* ignore */ }
}

function toggleLoop(checkbox) {
  document.getElementById('loop-settings').style.display = checkbox.checked ? 'block' : 'none';
}

// ─── 워크플로우 관리 ─────────────────────────────────────────

async function loadWorkflows() {
  try {
    const res = await fetch('/api/workflows');
    State.workflows = await res.json();
    renderWorkflowList();
  } catch { /* ignore */ }
}

function renderWorkflowList() {
  const list = document.getElementById('workflow-list');
  if (!State.workflows.length) {
    list.innerHTML = '<div class="empty-state">워크플로우가 없습니다.</div>';
    return;
  }

  list.innerHTML = State.workflows.map((wf) => `
    <div class="workflow-item ${wf.id === State.selectedWorkflowId ? 'active' : ''}"
         onclick="selectWorkflow('${wf.id}')">
      <div class="workflow-item-name">${escHtml(wf.name)}</div>
      <div class="workflow-item-desc">${escHtml(wf.description || '설명 없음')} · ${wf.steps.length}단계</div>
    </div>
  `).join('');
}

function selectWorkflow(id) {
  State.selectedWorkflowId = id;
  const wf = State.workflows.find((w) => w.id === id);
  if (!wf) return;

  renderWorkflowList();
  document.getElementById('wf-editor-empty').style.display = 'none';
  document.getElementById('wf-editor-form').style.display = 'block';

  document.getElementById('wf-name').value  = wf.name || '';
  document.getElementById('wf-desc').value  = wf.description || '';
  document.getElementById('wf-input').value = wf.input || '';

  State.currentWorkflowStepIds = [...(wf.steps || [])];
  renderStepsFlow();
}

function renderStepsFlow() {
  const flow = document.getElementById('steps-flow');
  if (!State.currentWorkflowStepIds.length) {
    flow.innerHTML = '<div class="empty-state small">스텝을 추가하세요.</div>';
    return;
  }

  flow.innerHTML = State.currentWorkflowStepIds.map((stepId, i) => {
    const step = State.steps.find((s) => s.id === stepId);
    const name = step ? step.name : `(삭제된 스텝: ${stepId})`;
    const hasLoop = step?.loop?.enabled;
    return `
      <div class="flow-step-card">
        <div class="flow-step-num">${i + 1}</div>
        <div class="flow-step-name">${escHtml(name)}</div>
        ${hasLoop ? '<span class="flow-step-loop">루프</span>' : ''}
        <button class="flow-step-remove" onclick="removeFlowStep(${i})" title="제거">✕</button>
      </div>
    `;
  }).join('');
}

function removeFlowStep(index) {
  State.currentWorkflowStepIds.splice(index, 1);
  renderStepsFlow();
}

async function createWorkflow() {
  try {
    const res = await fetch('/api/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '새 워크플로우', description: '', steps: [] }),
    });
    const wf = await res.json();
    await loadWorkflows();
    selectWorkflow(wf.id);
  } catch { /* ignore */ }
}

async function saveWorkflow() {
  if (!State.selectedWorkflowId) return;

  const data = {
    name: document.getElementById('wf-name').value,
    description: document.getElementById('wf-desc').value,
    input: document.getElementById('wf-input').value,
    steps: State.currentWorkflowStepIds,
  };

  try {
    await fetch(`/api/workflows/${State.selectedWorkflowId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    await loadWorkflows();
    showToast('워크플로우가 저장되었습니다.');
  } catch { /* ignore */ }
}

async function deleteCurrentWorkflow() {
  if (!State.selectedWorkflowId) return;
  if (!confirm('이 워크플로우를 삭제하시겠습니까?')) return;

  try {
    await fetch(`/api/workflows/${State.selectedWorkflowId}`, { method: 'DELETE' });
    State.selectedWorkflowId = null;
    State.currentWorkflowStepIds = [];
    document.getElementById('wf-editor-empty').style.display = 'flex';
    document.getElementById('wf-editor-form').style.display = 'none';
    await loadWorkflows();
  } catch { /* ignore */ }
}

function runCurrentWorkflow() {
  if (!State.selectedWorkflowId) return;
  switchTab('runner');
  loadWorkflowsForRunner().then(() => {
    document.getElementById('run-workflow-select').value = State.selectedWorkflowId;
    document.getElementById('run-input').value = document.getElementById('wf-input')?.value || '';
  });
}

// ─── 스텝 선택 모달 ─────────────────────────────────────────

function openStepSelector() {
  const modal = document.getElementById('step-selector-modal');
  const list  = document.getElementById('modal-steps-list');
  modal.style.display = 'flex';

  if (!State.steps.length) {
    list.innerHTML = '<div class="empty-state">스텝이 없습니다. 먼저 프롬프트 관리에서 스텝을 생성하세요.</div>';
    return;
  }

  list.innerHTML = State.steps.map((step) => `
    <div class="modal-step-item" onclick="addStepToFlow('${step.id}')">
      <span class="modal-step-name">${escHtml(step.name)}</span>
      <span class="modal-step-add">+ 추가</span>
    </div>
  `).join('');
}

function addStepToFlow(stepId) {
  State.currentWorkflowStepIds.push(stepId);
  renderStepsFlow();
  closeStepSelector();
}

function closeStepSelector(event) {
  if (event && event.target !== document.getElementById('step-selector-modal')) return;
  document.getElementById('step-selector-modal').style.display = 'none';
}

// ─── 실행 & 모니터링 ─────────────────────────────────────────

async function loadWorkflowsForRunner() {
  try {
    const res = await fetch('/api/workflows');
    State.workflows = await res.json();

    const sel = document.getElementById('run-workflow-select');
    sel.innerHTML = '<option value="">-- 워크플로우를 선택하세요 --</option>';
    State.workflows.forEach((wf) => {
      const opt = document.createElement('option');
      opt.value = wf.id;
      opt.textContent = `${wf.name} (${wf.steps.length}단계)`;
      sel.appendChild(opt);
    });
  } catch { /* ignore */ }
}

function connectSSE() {
  if (State.sseSource) {
    State.sseSource.close();
  }

  const source = new EventSource('/api/events');
  State.sseSource = source;

  source.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      handleSSEEvent(data);
    } catch { /* ignore */ }
  };

  source.onerror = () => {
    document.getElementById('server-status').innerHTML = `
      <span class="status-dot"></span>
      <span class="status-text">연결 끊김 — 재연결 중...</span>
    `;
    setTimeout(connectSSE, 3000);
  };

  source.onopen = () => {
    document.getElementById('server-status').innerHTML = `
      <span class="status-dot connected"></span>
      <span class="status-text">서버 연결됨</span>
    `;
  };
}

function handleSSEEvent(data) {
  switch (data.type) {
    case 'workflow_start':
      State.runStatus = 'running';
      State.stepResults = [];                          // 단계별 결과 초기화
      updateRunBadge('running', '실행 중');
      document.getElementById('btn-run').disabled = true;
      document.getElementById('btn-abort').disabled = false;
      document.getElementById('result-card').style.display = 'none';
      document.getElementById('progress-section').style.display = 'block';

      addLogSep();
      addLog(`▶ 워크플로우 시작: ${data.workflowName} (${data.totalSteps}단계)`, 'accent');
      renderProgressSteps(data.totalSteps);
      break;

    case 'step_start':
      addLogSep();
      addLog(`━━━ [${data.stepIndex}/${data.totalSteps}] ${data.stepName} ━━━`, 'accent');
      addLog(`🔄 Gemini 호출 준비 중...`, 'info');
      updateProgressStep(data.stepIndex, 'running');
      break;

    case 'step_prompt':
      // ── 질의 프롬프트 전문 표시 ──
      addLog(`📤 [질의 프롬프트]`, 'info');
      addLogBlock(data.promptPreview || data.prompt || '', 'prompt-block');
      break;

    case 'step_log':
      addLog(`   └ ${data.message}`, 'info');
      break;

    case 'step_done':
      // ── 응답 전문 표시 ──
      addLog(`📥 [Gemini 응답] (${(data.output || '').length}자, ${data.loopCount}회 시도)`, 'success');
      addLogBlock(data.outputPreview || data.output || '', 'response-block');
      addLog(`✅ ${data.stepName} 완료`, 'success');
      updateProgressStepByName(data.stepName, 'done');

      // 단계별 결과 저장
      State.stepResults = State.stepResults || [];
      State.stepResults.push({ name: data.stepName, output: data.output || '' });
      break;

    case 'step_error':
      addLog(`❌ [${data.stepName}] 오류: ${data.error}`, 'error');
      updateProgressStepByName(data.stepName, 'error');
      break;

    case 'workflow_done':
      State.runStatus = 'done';
      updateRunBadge('done', '완료');
      document.getElementById('btn-run').disabled = false;
      document.getElementById('btn-abort').disabled = true;
      addLogSep();
      addLog('🎉 워크플로우 완료!', 'accent');
      State.finalResult = data.finalOutput || '';

      // 최종 결과 표시 (전체 단계 결과 요약)
      if (State.stepResults && State.stepResults.length > 0) {
        document.getElementById('result-card').style.display = 'flex';
        const resultHtml = buildFullResultText(State.stepResults);
        document.getElementById('result-viewer').textContent = resultHtml;
        State.finalResult = resultHtml;
      } else if (State.finalResult) {
        document.getElementById('result-card').style.display = 'flex';
        document.getElementById('result-viewer').textContent = State.finalResult;
      }
      break;

    case 'aborted':
      State.runStatus = 'idle';
      updateRunBadge('idle', '중단됨');
      document.getElementById('btn-run').disabled = false;
      document.getElementById('btn-abort').disabled = true;
      addLog('⏹ 실행이 중단되었습니다.', 'warning');
      break;

    case 'error':
      addLog(`[오류] ${data.message}`, 'error');
      break;
  }
}

let progressStepsCount = 0;

function renderProgressSteps(total) {
  progressStepsCount = total;
  const wfId = document.getElementById('run-workflow-select').value;
  const wf = State.workflows.find((w) => w.id === wfId);
  const stepNames = wf ? wf.steps.map((id) => {
    const s = State.steps.find((st) => st.id === id);
    return s ? s.name : id;
  }) : [];

  const container = document.getElementById('steps-progress');
  container.innerHTML = Array.from({ length: total }, (_, i) => `
    <div class="progress-step pending" id="prog-step-${i + 1}">
      <span class="progress-step-icon">⏳</span>
      <span>${stepNames[i] || `스텝 ${i + 1}`}</span>
    </div>
  `).join('');
}

function updateProgressStep(index, status) {
  const el = document.getElementById(`prog-step-${index}`);
  if (!el) return;
  const icons = { running: '🔄', done: '✅', error: '❌', pending: '⏳' };
  el.className = `progress-step ${status}`;
  el.querySelector('.progress-step-icon').textContent = icons[status] || '⏳';
}

let progressNameMap = {};
function updateProgressStepByName(name, status) {
  // 이름으로 인덱스를 찾아 업데이트 (간소화)
  const items = document.querySelectorAll('.progress-step');
  items.forEach((el) => {
    if (el.textContent.includes(name)) {
      const icons = { running: '🔄', done: '✅', error: '❌', pending: '⏳' };
      el.className = `progress-step ${status}`;
      el.querySelector('.progress-step-icon').textContent = icons[status] || '⏳';
    }
  });
}

function updateRunBadge(status, label) {
  const badge = document.getElementById('run-status-badge');
  const dot = badge.querySelector('.badge-dot');
  dot.className = `badge-dot ${status}`;
  badge.querySelector('span:last-child').textContent = label;
}

async function runWorkflow() {
  const workflowId = document.getElementById('run-workflow-select').value;
  const input = document.getElementById('run-input').value;

  if (!workflowId) {
    alert('워크플로우를 선택하세요.');
    return;
  }

  // 스텝 미리 로드
  await loadSteps();
  clearLog();

  try {
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId, input }),
    });
    const data = await res.json();
    if (!data.ok) {
      addLog(`실행 실패: ${data.error}`, 'error');
    }
  } catch (err) {
    addLog(`실행 오류: ${err.message}`, 'error');
  }
}

async function abortRun() {
  try {
    await fetch('/api/abort', { method: 'POST' });
  } catch { /* ignore */ }
}

function addLog(text, type = 'info') {
  const viewer = document.getElementById('log-viewer');
  const empty  = viewer.querySelector('.log-empty');
  if (empty) empty.remove();

  const now  = new Date().toLocaleTimeString('ko-KR');
  const line = document.createElement('div');
  line.className   = `log-line ${type}`;
  line.textContent = `[${now}] ${text}`;
  viewer.appendChild(line);
  viewer.scrollTop = viewer.scrollHeight;
}

/** 구분선 삽입 */
function addLogSep() {
  const viewer = document.getElementById('log-viewer');
  const sep    = document.createElement('div');
  sep.className   = 'log-sep';
  sep.textContent = '─'.repeat(60);
  viewer.appendChild(sep);
  viewer.scrollTop = viewer.scrollHeight;
}

/**
 * 프롬프트 또는 응답 전문을 스크롤 가능한 박스로 표시
 * @param {string} text  - 표시할 내용
 * @param {string} kind  - 'prompt-block' | 'response-block'
 */
function addLogBlock(text, kind = 'response-block') {
  const viewer  = document.getElementById('log-viewer');
  const wrapper = document.createElement('div');
  wrapper.className = `log-block ${kind}`;

  const pre = document.createElement('pre');
  pre.className   = 'log-block-pre';
  pre.textContent = text || '(내용 없음)';
  wrapper.appendChild(pre);
  viewer.appendChild(wrapper);
  viewer.scrollTop = viewer.scrollHeight;
}

/** 전체 단계 결과를 하나의 텍스트로 합쳐 반환 */
function buildFullResultText(stepResults) {
  return stepResults.map((r, i) =>
    `${'═'.repeat(60)}\n[Step ${i + 1}] ${r.name}\n${'─'.repeat(60)}\n${r.output}\n`
  ).join('\n');
}

function clearLog() {
  document.getElementById('log-viewer').innerHTML =
    '<div class="log-empty">실행을 시작하면 로그가 여기에 표시됩니다.</div>';
  State.stepResults = [];
}

function copyResult() {
  if (State.finalResult) {
    navigator.clipboard.writeText(State.finalResult)
      .then(() => showToast('결과가 복사되었습니다.'));
  }
}


// ─── 유틸리티 ───────────────────────────────────────────────

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let toastTimeout;
function showToast(msg) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.style.cssText = `
      position:fixed; bottom:28px; right:28px;
      background:#7c5cfc; color:#fff;
      padding:10px 20px; border-radius:8px;
      font-size:13.5px; font-weight:600;
      box-shadow:0 4px 20px rgba(124,92,252,0.4);
      z-index:9999; transition:opacity 0.3s;
    `;
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = '1';
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { toast.style.opacity = '0'; }, 2500);
}

// ─── 데이터 백업/복구 (Export & Import) ──────────────────────

async function exportData() {
  try {
    const res = await fetch('/api/export');
    if (!res.ok) throw new Error('내보내기 실패');
    const data = await res.json();
    
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ai_multiagent_backup_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('데이터 내보내기가 완료되었습니다.');
  } catch (err) {
    showToast(`내보내기 오류: ${err.message}`);
  }
}

async function importData(event) {
  const file = event.target.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const data = JSON.parse(text);

    const res = await fetch('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    
    if (!res.ok) {
      const errorData = await res.json();
      throw new Error(errorData.error || '가져오기 실패');
    }

    showToast('데이터 가져오기(병합)가 완료되었습니다.');
    
    // 데이터 새로고침
    if (State.activeTab === 'prompts') loadSteps();
    else if (State.activeTab === 'workflow') { loadSteps(); loadWorkflows(); }
    else if (State.activeTab === 'runner') loadWorkflowsForRunner();
    
  } catch (err) {
    showToast(`가져오기 오류: ${err.message}`);
  } finally {
    event.target.value = ''; // input 초기화
  }
}

// ─── 초기화 ─────────────────────────────────────────────────
async function init() {
  connectSSE();
  await loadSessionStatus();
}

init();
