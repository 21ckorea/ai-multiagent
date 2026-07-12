'use strict';

/**
 * @file workflow_store.js
 * @description JSON 파일 기반 워크플로우 & 스텝 저장소
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DATA_DIR = path.resolve(process.cwd(), 'data', 'workflows');
const WORKFLOWS_FILE = path.join(DATA_DIR, 'workflows.json');
const STEPS_FILE = path.join(DATA_DIR, 'steps.json');

function ensureFiles() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(WORKFLOWS_FILE)) {
    fs.writeFileSync(WORKFLOWS_FILE, JSON.stringify([], null, 2), 'utf8');
  }
  if (!fs.existsSync(STEPS_FILE)) {
    fs.writeFileSync(STEPS_FILE, JSON.stringify([], null, 2), 'utf8');
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// ─── Workflows ───────────────────────────────────────────────

function getAllWorkflows() {
  ensureFiles();
  return readJson(WORKFLOWS_FILE);
}

function getWorkflow(id) {
  return getAllWorkflows().find((w) => w.id === id) || null;
}

function createWorkflow(data) {
  ensureFiles();
  const workflows = getAllWorkflows();
  const now = new Date().toISOString();
  const workflow = {
    id: `wf_${uuidv4().slice(0, 8)}`,
    name: data.name || '새 워크플로우',
    description: data.description || '',
    steps: data.steps || [],
    input: data.input || '',
    createdAt: now,
    updatedAt: now,
  };
  workflows.push(workflow);
  writeJson(WORKFLOWS_FILE, workflows);
  return workflow;
}

function updateWorkflow(id, data) {
  ensureFiles();
  const workflows = getAllWorkflows();
  const idx = workflows.findIndex((w) => w.id === id);
  if (idx === -1) return null;
  workflows[idx] = { ...workflows[idx], ...data, id, updatedAt: new Date().toISOString() };
  writeJson(WORKFLOWS_FILE, workflows);
  return workflows[idx];
}

function deleteWorkflow(id) {
  ensureFiles();
  const workflows = getAllWorkflows().filter((w) => w.id !== id);
  writeJson(WORKFLOWS_FILE, workflows);
  return true;
}

// ─── Steps ───────────────────────────────────────────────────

function getAllSteps() {
  ensureFiles();
  return readJson(STEPS_FILE);
}

function getStep(id) {
  return getAllSteps().find((s) => s.id === id) || null;
}

function createStep(data) {
  ensureFiles();
  const steps = getAllSteps();
  const now = new Date().toISOString();
  const step = {
    id: `step_${uuidv4().slice(0, 8)}`,
    type: data.type || 'gemini',
    name: data.name || '새 스텝',
    prompt: data.prompt || '',
    newChat: data.newChat !== false,
    timeout: data.timeout || 120000,
    loop: {
      enabled: data.loop?.enabled || false,
      condition: data.loop?.condition || 'none',
      conditionValue: data.loop?.conditionValue || '',
      maxRetries: data.loop?.maxRetries || 3,
      retryDelayMs: data.loop?.retryDelayMs || 2000,
      gotoStepId: data.loop?.gotoStepId || '',
    },
    createdAt: now,
    updatedAt: now,
  };
  steps.push(step);
  writeJson(STEPS_FILE, steps);
  return step;
}

function updateStep(id, data) {
  ensureFiles();
  const steps = getAllSteps();
  const idx = steps.findIndex((s) => s.id === id);
  if (idx === -1) return null;
  steps[idx] = { ...steps[idx], ...data, id, updatedAt: new Date().toISOString() };
  writeJson(STEPS_FILE, steps);
  return steps[idx];
}

function deleteStep(id) {
  ensureFiles();
  const steps = getAllSteps().filter((s) => s.id !== id);
  writeJson(STEPS_FILE, steps);
  return true;
}

module.exports = {
  getAllWorkflows,
  getWorkflow,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  getAllSteps,
  getStep,
  createStep,
  updateStep,
  deleteStep,
};
