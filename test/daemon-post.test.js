import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createState, saveState } from '../src/store.js';
import { readDaemon, ensureDaemon, api } from '../src/client.js';

process.env.AGENTHERD_CLAUDE = new URL('./fake-claude', import.meta.url).pathname;
let folder;
after(() => { const d = folder && readDaemon(folder); if (d) try { process.kill(d.pid, 'SIGTERM'); } catch {} });

const post = (port, p, body, headers = { 'Content-Type': 'application/json' }) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: p, headers }, (res) => {
    let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
  });
  req.on('error', reject);
  req.end(typeof body === 'string' ? body : JSON.stringify(body));
});

test('POST endpoint validation and acceptance', async () => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-p-'));
  const s = createState(folder, { goal: 'g', existingCode: false });
  s.status = 'paused';
  saveState(s);
  delete process.env.AGENTHERD_TEST_UNSET_12345;
  fs.writeFileSync(path.join(folder, '.agentherd', 'providers.json'), JSON.stringify({
    profiles: {
      custom: { label: 'Custom endpoint', env: { ANTHROPIC_BASE_URL: 'https://custom.test' } },
      needsEnv: { label: 'Needs env', env: { ANTHROPIC_AUTH_TOKEN: '${AGENTHERD_TEST_UNSET_12345}' } },
    },
  }));
  const { port } = await ensureDaemon(folder);
  const state = () => api(port, 'GET', '/api/state');
  const initial = await state();
  assert.equal(initial.provider, 'claude');
  assert.ok(initial.providers.some((p) => p.name === 'custom' && p.label === 'Custom endpoint'));
  assert.ok(initial.providers.some((p) => p.name === 'claude'));
  assert.doesNotMatch(JSON.stringify(initial), /custom\.test|AGENTHERD_TEST_UNSET_12345/);

  // wrong / missing content type
  assert.equal((await post(port, '/api/message', '{"text":"hi"}', {})).status, 415);
  assert.equal((await post(port, '/api/control', '{"action":"pause"}', { 'Content-Type': 'application/x-www-form-urlencoded' })).status, 415);

  // malformed JSON
  assert.equal((await post(port, '/api/message', '{"text":')).status, 400);
  assert.equal((await post(port, '/api/control', 'not json')).status, 400);

  // oversized
  assert.equal((await post(port, '/api/control', JSON.stringify({ action: 'x'.repeat(70 * 1024) }))).status, 413);

  // missing / invalid fields: message
  for (const b of [{}, { text: '' }, { text: '   ' }, { text: 5 }, { text: null }, { text: ['a'] }, { other: 'x' }]) {
    assert.equal((await post(port, '/api/message', b)).status, 400, JSON.stringify(b));
  }
  // missing / invalid fields: control
  for (const b of [{}, { action: 'explode' }, { action: 5 }, { maxAgents: 0 }, { maxAgents: 7 }, { maxAgents: 2.5 }, { maxAgents: '3' }, { maxAgents: null },
    { provider: 5 }, { provider: 'nope' }, { provider: null }, { provider: '' }, { provider: 'needsEnv' }]) {
    assert.equal((await post(port, '/api/control', b)).status, 400, JSON.stringify(b));
  }
  // rejected requests changed nothing
  let st = await state();
  assert.equal(st.messages.length, 0);
  assert.equal(st.status, 'paused');
  assert.equal(st.provider, 'claude');

  // valid requests
  const ok = await post(port, '/api/message', { text: '  hello  ' });
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.body), { ok: true });
  assert.equal((await state()).messages[0].text, 'hello');
  for (const m of [1, 6]) {
    assert.equal((await post(port, '/api/control', { maxAgents: m })).status, 200);
    assert.equal((await state()).maxAgents, m);
  }
  assert.equal((await post(port, '/api/control', { provider: 'custom' })).status, 200);
  st = await state();
  assert.equal(st.provider, 'custom');
  assert.equal(st.providerLabel, 'Custom endpoint');
  assert.equal((await post(port, '/api/control', { provider: 'claude' })).status, 200);
  assert.equal((await state()).provider, 'claude');
  assert.equal((await post(port, '/api/control', { action: 'resume', maxAgents: 2 })).status, 200);
  st = await state();
  assert.equal(st.status, 'running');
  assert.equal(st.maxAgents, 2);
  assert.equal((await post(port, '/api/control', { action: 'pause' })).status, 200);
  assert.equal((await state()).status, 'paused');
});
