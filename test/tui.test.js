import test from 'node:test';
import assert from 'node:assert/strict';
import { renderView, tasksText, taskText } from '../src/tui.js';
import { STATUSES } from '../src/store.js';
import { ROLES } from '../src/roles.js';

const mk = (over = {}) => ({
  folder: '/x/myapp', status: 'paused', maxAgents: 6, resumeAt: null,
  tasks: [
    { id: 1, title: 'Setup', status: 'backlog', role: 'backend' },
    { id: 2, title: 'Add login form', status: 'in_progress', role: 'frontend' },
  ],
  counts: { backlog: 1, in_progress: 1, review: 0, done: 0, blocked: 0 },
  agents: Object.fromEntries(Object.keys(ROLES).map((r) => [r, { status: 'idle', taskId: null }])),
  activity: Array.from({ length: 30 }, (_, i) => ({ t: 0, agent: 'Lead', text: `did thing ${i} `.repeat(10) })),
  ...over,
});
const withWorker = (s) => { s.agents.frontend = { status: 'working', taskId: 2 }; return s; };

test('header shows paused', () => {
  assert.match(renderView(mk(), { width: 80, height: 30 }).split('\n')[0], /agentHerd · myapp · paused · agents 0\/6/);
});
test('limited shows resume time', () => {
  const h = renderView(mk({ status: 'limited', resumeAt: new Date(2026, 0, 1, 14, 5).getTime() }), { width: 90, height: 30 }).split('\n')[0];
  assert.match(h, /paused – usage limit, resumes 14:05/);
});
test('counts line', () => {
  assert.ok(renderView(mk(), { width: 80, height: 30 }).includes('Backlog 1 · In progress 1 · Review 0 · Done 0 · Blocked 0'));
});
test('agent lines', () => {
  const out = renderView(withWorker(mk()), { width: 80, height: 30 });
  assert.match(out, /● Frontend dev\s+T2 Add login form/);
  assert.match(out, /○ QA\s+idle/);
  assert.match(out.split('\n')[0], /agents 1\/6/);
});
test('clips to width and height', () => {
  const out = renderView(withWorker(mk()), { width: 40, height: 25 });
  const lines = out.split('\n');
  assert.ok(lines.every((l) => l.length <= 40));
  assert.ok(lines.length <= 23);
});

test('/tasks lists every shared status, even empty ones', () => {
  const out = tasksText(mk());
  for (const s of STATUSES) assert.match(out, new RegExp(`^${s} \\(\\d+\\)$`, 'm'));
  assert.match(out, /blocked \(0\)/);
  assert.match(out, /in_progress \(1\)\n  T2 \[frontend\] Add login form/);
});
test('/task shows notes', () => {
  const s = mk();
  s.tasks[0] = { ...s.tasks[0], notes: ['first note', 'second'], attempts: 1, reviewRounds: 0 };
  assert.match(taskText(s, 1), /notes:\n  - first note\n  - second/);
  s.tasks[0].notes = [];
  assert.doesNotMatch(taskText(s, 1), /notes:/);
  assert.equal(taskText(s, 99), 'No task T99.');
});

test('header shows lost connection', () => {
  assert.match(renderView(mk(), { width: 80, height: 30, disconnected: true }).split('\n')[0], /lost connection to the team, reconnecting…/);
});
