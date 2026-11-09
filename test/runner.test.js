import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROLES } from '../src/roles.js';
import { buildArgs, parseLine, isLimitError, runAgent } from '../src/runner.js';

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-claude');

test('buildArgs includes dontAsk and schema', () => {
  const args = buildArgs(ROLES.researcher, 'do it');
  const has = (a, b) => args.some((x, i) => x === a && args[i + 1] === b);
  assert.ok(has('--permission-mode', 'dontAsk'));
  assert.ok(has('--model', 'haiku'));
  assert.ok(has('-p', 'do it'));
  const schema = JSON.parse(args[args.indexOf('--json-schema') + 1]);
  assert.ok(schema.properties.status);
});

test('buildArgs: lead and reviewer get read-only tools, workers the full list', () => {
  const tools = (role) => buildArgs(role, 'x').slice(buildArgs(role, 'x').indexOf('--allowedTools') + 1);
  for (const r of [ROLES.lead, ROLES.reviewer]) {
    assert.ok(!tools(r).some((t) => /Edit|Write|npm|node/.test(t)));
    assert.ok(tools(r).includes('Bash(git diff*)'));
  }
  // qa pipes test output through tail/grep (e.g. `npm test 2>&1 | tail -15`); every part must be allowed
  for (const t of ['Edit', 'Bash(npm *)', 'Bash(node *)', 'Bash(cargo *)', 'Bash(tail *)', 'Bash(grep *)', 'Bash(cat *)', 'Bash(head *)'])
    assert.ok(tools(ROLES.qa).includes(t), t);
});

test('parseLine tool_use', () => {
  const line = '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"src/a.js"}}]}}';
  assert.deepEqual(parseLine(line), { activity: 'Edit src/a.js' });
});

test('parseLine result and garbage', () => {
  assert.deepEqual(parseLine('{"type":"result","is_error":false}'), { result: { type: 'result', is_error: false } });
  assert.deepEqual(parseLine('nope'), {});
});

test('isLimitError', () => {
  assert.equal(isLimitError({ is_error: true, result: 'Claude usage limit reached' }), true);
  assert.equal(isLimitError({ is_error: false, result: 'limit' }), false);
});

test('runAgent with fake claude', async () => {
  process.env.AGENTHERD_CLAUDE = fake;
  const seen = [];
  const r = await runAgent({ role: ROLES.qa, prompt: 'x', cwd: process.cwd(), onActivity: (t) => seen.push(t) }).promise;
  assert.equal(r.ok, true);
  assert.equal(r.output.status, 'done');
  assert.deepEqual(seen, ['Edit src/a.js']);
});

test('runAgent detects limit', async () => {
  process.env.AGENTHERD_CLAUDE = fake;
  process.env.FAKE_MODE = 'limit';
  try {
    const r = await runAgent({ role: ROLES.qa, prompt: 'x', cwd: process.cwd(), onActivity() {} }).promise;
    assert.equal(r.ok, false);
    assert.equal(r.limit, true);
  } finally { delete process.env.FAKE_MODE; }
});

test('kill resolves with killed', async () => {
  process.env.AGENTHERD_CLAUDE = fake;
  process.env.FAKE_MODE = 'hang';
  const h = runAgent({ role: ROLES.qa, prompt: 'x', cwd: process.cwd(), onActivity() {} });
  setTimeout(() => h.kill(), 50);
  try { assert.deepEqual(await h.promise, { ok: false, error: 'killed' }); } finally { delete process.env.FAKE_MODE; }
});
