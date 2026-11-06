import fs from 'node:fs';
import path from 'node:path';
import { ROLES as ROLE_DEFS } from './roles.js';

const ROLES = Object.keys(ROLE_DEFS);
const STATUSES = ['backlog', 'in_progress', 'review', 'done', 'blocked'];
const statePath = (folder) => path.join(folder, '.agentherd', 'state.json');

export function loadState(folder) {
  try {
    return JSON.parse(fs.readFileSync(statePath(folder), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export function saveState(state) {
  const file = statePath(state.folder);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(state, null, 2));
  fs.renameSync(file + '.tmp', file);
}

export function createState(folder, { goal, existingCode }) {
  const state = {
    folder, goal, existingCode,
    status: 'running', resumeAt: null, maxAgents: 6, nextId: 1,
    tasks: [], messages: [], activity: [],
    agents: Object.fromEntries(ROLES.map((r) => [r, { status: 'idle', taskId: null }])),
  };
  if (existingCode) {
    addTask(state, {
      title: 'Research the existing codebase',
      description: 'Write docs/TEAM_NOTES.md covering stack, structure, and how to run/test.',
      role: 'researcher', createdBy: 'system',
    });
  }
  saveState(state);
  return state;
}

export function addTask(state, { title, description, role, createdBy }) {
  const task = {
    id: state.nextId++, title, description, role, status: 'backlog', createdBy,
    attempts: 0, reviewRounds: 0, notes: [], branch: null, commit: null, reviewing: false,
  };
  state.tasks.push(task);
  return task;
}

export function counts(state) {
  const c = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const t of state.tasks) c[t.status]++;
  return c;
}

export function log(state, agent, text) {
  state.activity.push({ t: Date.now(), agent, text });
  if (state.activity.length > 200) state.activity.splice(0, state.activity.length - 200);
}
