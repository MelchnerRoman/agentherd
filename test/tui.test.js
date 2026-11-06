import test from 'node:test';
import assert from 'node:assert/strict';
import { renderView } from '../src/tui.js';
import { ROLES } from '../src/roles.js';

const mk = (over = {}) => ({
  folder: '/x/myapp', status: 'paused', maxAgents: 6, resumeAt: null,
  tasks: [
    { id: 1, title: 'Setup', status: 'backlog', role: 'backend' },
    { id: 2, title: 'Add login form', status: 'in_progress', role: 'frontend' },
  ],
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
