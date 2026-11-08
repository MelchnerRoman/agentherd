import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import { loadState, saveState, createState, addTask, counts, log } from '../src/store.js';

const tmp = () => fs.mkdtempSync(os.tmpdir() + '/ah-');
const opts = { goal: 'todo app', existingCode: false };

test('createState then loadState round-trips', () => {
  const dir = tmp();
  const s = createState(dir, opts);
  assert.equal(loadState(dir).goal, 'todo app');
  assert.equal(Object.keys(s.agents).length, 6);
});

test('existingCode seeds researcher task', () => {
  const s = createState(tmp(), { goal: 'x', existingCode: true });
  assert.equal(s.tasks[0].role, 'researcher');
  assert.equal(s.tasks[0].status, 'backlog');
});

test('addTask increments ids', () => {
  const s = createState(tmp(), opts);
  const t = { title: 'a', description: 'd', role: 'backend', createdBy: 'lead' };
  assert.equal(addTask(s, t).id, 1);
  assert.equal(addTask(s, t).id, 2);
  assert.equal(s.nextId, 3);
});

test('counts', () => {
  const s = createState(tmp(), opts);
  const t = { title: 'a', description: 'd', role: 'backend', createdBy: 'lead' };
  addTask(s, t).status = 'done';
  addTask(s, t);
  assert.deepEqual(counts(s), { backlog: 1, in_progress: 0, review: 0, done: 1, blocked: 0 });
});

test('log keeps last 200', () => {
  const s = createState(tmp(), opts);
  for (let i = 0; i < 250; i++) log(s, 'lead', 'm' + i);
  assert.equal(s.activity.length, 200);
  assert.equal(s.activity.at(-1).text, 'm249');
});

test('saveState writes via tmp+rename: no tmp left, reload is complete JSON', () => {
  const dir = tmp();
  const s = createState(dir, opts);
  addTask(s, { title: 'a', description: 'd', role: 'backend', createdBy: 'lead' });
  saveState(s);
  assert.equal(fs.existsSync(dir + '/.agentherd/state.json.tmp'), false);
  assert.deepEqual(loadState(dir), JSON.parse(JSON.stringify(s)));
});

test('stale partial tmp file does not corrupt state and is replaced on save', () => {
  const dir = tmp();
  const s = createState(dir, opts);
  const file = dir + '/.agentherd/state.json';
  fs.writeFileSync(file + '.tmp', '{"partial'); // simulated crash mid-write
  assert.equal(loadState(dir).goal, 'todo app');
  s.goal = 'new';
  saveState(s);
  assert.equal(loadState(dir).goal, 'new');
  assert.equal(fs.existsSync(file + '.tmp'), false);
});

test('log drops oldest entry at the cap and keeps order', () => {
  const s = createState(tmp(), opts);
  for (let i = 0; i < 200; i++) log(s, 'lead', 'm' + i);
  assert.equal(s.activity.length, 200);
  log(s, 'lead', 'm200');
  assert.equal(s.activity.length, 200);
  assert.equal(s.activity[0].text, 'm1');
  assert.equal(s.activity.at(-1).text, 'm200');
});

test('task status transitions are reflected in counts and persist', () => {
  const dir = tmp();
  const s = createState(dir, opts);
  const t = addTask(s, { title: 'a', description: 'd', role: 'backend', createdBy: 'lead' });
  assert.equal(t.status, 'backlog');
  for (const status of ['in_progress', 'review', 'blocked', 'done']) {
    t.status = status;
    const c = counts(s);
    assert.equal(c[status], 1);
    assert.equal(Object.values(c).reduce((a, b) => a + b, 0), 1);
  }
  saveState(s);
  assert.equal(loadState(dir).tasks[0].status, 'done');
});

test('loadState missing returns null', () => {
  assert.equal(loadState(tmp()), null);
});
