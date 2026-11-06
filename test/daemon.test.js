import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createState, saveState } from '../src/store.js';
import { readDaemon, ensureDaemon, api, subscribe } from '../src/client.js';

process.env.AGENTHERD_CLAUDE = new URL('./fake-claude.js', import.meta.url).pathname;
const folders = [];
function mk() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-d-'));
  const s = createState(folder, { goal: 'g', existingCode: false });
  s.status = 'paused';
  saveState(s);
  folders.push(folder);
  return folder;
}
after(() => {
  for (const f of folders) { const d = readDaemon(f); if (d) try { process.kill(d.pid, 'SIGTERM'); } catch {} }
});
const gone = async (pid) => { for (let i = 0; i < 50; i++) { try { process.kill(pid, 0); } catch { return true; } await new Promise((r) => setTimeout(r, 100)); } return false; };

test('ensureDaemon starts once', async () => {
  const f = mk();
  const a = await ensureDaemon(f), b = await ensureDaemon(f);
  assert.equal(a.port, b.port);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f, '.agentherd/daemon.json'))).pid, readDaemon(f).pid);
});

test('stale daemon.json is replaced', async () => {
  const f = mk();
  fs.writeFileSync(path.join(f, '.agentherd/daemon.json'), JSON.stringify({ pid: 999999, port: 1 }));
  const { port } = await ensureDaemon(f);
  assert.notEqual(port, 1);
  assert.notEqual(readDaemon(f).pid, 999999);
});

test('message + control', async () => {
  const f = mk();
  const { port } = await ensureDaemon(f);
  assert.equal((await api(port, 'POST', '/api/message', { text: 'hi' }))._status, 200);
  assert.equal((await api(port, 'POST', '/api/message', { text: ' ' }))._status, 400);
  let s = await api(port, 'GET', '/api/state');
  assert.equal(s.messages.length, 1);
  assert.ok(s.counts);
  await api(port, 'POST', '/api/control', { maxAgents: 3 });
  s = await api(port, 'GET', '/api/state');
  assert.equal(s.maxAgents, 3);
  assert.equal((await api(port, 'POST', '/api/control', { maxAgents: 9 }))._status, 400);
  assert.equal((await api(port, 'POST', '/api/control', { action: 'nope' }))._status, 400);
  assert.equal((await api(port, 'GET', '/nothing'))._status, 404);
});

test('subscribe receives state', async () => {
  const f = mk();
  const { port } = await ensureDaemon(f);
  const st = await new Promise((resolve) => { const un = subscribe(port, (s) => { un(); resolve(s); }); });
  assert.ok(Array.isArray(st.tasks));
});

test('stop exits and removes daemon.json', async () => {
  const f = mk();
  const { port } = await ensureDaemon(f);
  const { pid } = readDaemon(f);
  assert.equal((await api(port, 'POST', '/api/control', { action: 'stop' }))._status, 200);
  assert.ok(await gone(pid));
  assert.equal(fs.existsSync(path.join(f, '.agentherd/daemon.json')), false);
});
