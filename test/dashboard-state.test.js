import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createState, addTask, log, saveState } from '../src/store.js';
import { readDaemon, ensureDaemon, api } from '../src/client.js';

process.env.AGENTHERD_CLAUDE = new URL('./fake-claude', import.meta.url).pathname;
let folder;
after(() => { const d = folder && readDaemon(folder); if (d) try { process.kill(d.pid, 'SIGTERM'); } catch {} });

const firstEvent = (port) => new Promise((resolve, reject) => {
  const req = http.get({ host: '127.0.0.1', port, path: '/api/events' }, (res) => {
    assert.match(res.headers['content-type'], /text\/event-stream/);
    let b = '';
    res.on('data', (c) => {
      b += c;
      const i = b.indexOf('\n\n');
      if (i < 0) return;
      req.destroy();
      resolve(JSON.parse(b.slice(0, i).replace(/^data: /, '')));
    });
  });
  req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
});

// Fields web/index.html render() reads.
function checkShape(s) {
  for (const k of ['goal', 'folder', 'status', 'maxAgents']) assert.ok(k in s, k);
  assert.equal(typeof s.folder, 'string');
  assert.ok(['running', 'paused', 'limited', 'stopped'].includes(s.status));
  assert.ok(Array.isArray(s.tasks));
  assert.ok(Array.isArray(s.activity));
  for (const id of ['lead', 'researcher', 'frontend', 'backend', 'qa', 'reviewer']) {
    assert.ok(['idle', 'working'].includes(s.agents[id].status), id);
  }
  for (const k of ['backlog', 'in_progress', 'review', 'done', 'blocked']) {
    assert.equal(typeof s.counts[k], 'number', k);
  }
  for (const t of s.tasks) {
    for (const k of ['id', 'title', 'role', 'status']) assert.ok(k in t, k);
    assert.ok(t.status in s.counts, t.status);
  }
  for (const a of s.activity) for (const k of ['t', 'agent', 'text']) assert.ok(k in a, k);
}

test('/api/state and first SSE message carry the fields the dashboard reads', async () => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-d-'));
  const s = createState(folder, { goal: 'dash goal', existingCode: false });
  s.status = 'paused';
  addTask(s, { title: 'T one', description: 'd', role: 'backend', createdBy: 'lead' });
  log(s, 'lead', 'hello');
  saveState(s);
  const { port } = await ensureDaemon(folder);

  const st = await api(port, 'GET', '/api/state');
  checkShape(st);
  assert.equal(st.goal, 'dash goal');
  assert.equal(st.status, 'paused');
  assert.equal(st.counts.backlog, 1);
  assert.equal(st.tasks[0].title, 'T one');
  assert.ok(st.activity.some((a) => a.text === 'hello' && a.agent === 'lead'));

  const ev = await firstEvent(port);
  checkShape(ev);
  assert.equal(ev.goal, st.goal);
  assert.deepEqual(ev.counts, st.counts);
  assert.deepEqual(ev.tasks, st.tasks);
});
