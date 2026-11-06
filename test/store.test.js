import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import { loadState, createState, addTask, counts, log } from '../src/store.js';

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

test('loadState missing returns null', () => {
  assert.equal(loadState(tmp()), null);
});
