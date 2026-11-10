import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  defaultProviders, loadProviders, providerEnv, providerModel, activeProvider, providerList,
} from '../src/providers.js';
import { ROLES } from '../src/roles.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ah-prov-'));
const write = (folder, data) => {
  fs.mkdirSync(path.join(folder, '.agentherd'), { recursive: true });
  fs.writeFileSync(path.join(folder, '.agentherd', 'providers.json'), JSON.stringify(data));
};

test('built-in profiles', () => {
  const p = defaultProviders();
  assert.ok(p.claude && p.subscription && p.anthropic && p.bedrock && p.vertex);
  assert.ok(p.kimi && p.moonshot && p.openrouter);
  assert.equal(p.claude.inherit, true);
  assert.deepEqual(providerList(p).map((x) => x.name).sort(),
    ['anthropic', 'bedrock', 'claude', 'kimi', 'moonshot', 'openrouter', 'subscription', 'vertex']);
});

test('missing providers.json returns the built-ins', () => {
  assert.deepEqual(loadProviders(tmp()), defaultProviders());
});

test('file profiles are merged over the built-ins', () => {
  const folder = tmp();
  write(folder, { profiles: { glm: { label: 'Z.ai GLM', env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' } } } });
  const p = loadProviders(folder);
  assert.equal(p.glm.label, 'Z.ai GLM');
  assert.equal(p.glm.env.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic');
  assert.ok(p.claude);
});

test('a file profile extends a built-in instead of replacing it', () => {
  const folder = tmp();
  write(folder, { profiles: { kimi: { env: { ANTHROPIC_API_KEY: 'kimi-literal' }, models: { default: 'k3.1-pro' } } } });
  const p = loadProviders(folder);
  assert.equal(p.kimi.label, 'Kimi Code (subscription)');
  assert.equal(p.kimi.env.ANTHROPIC_BASE_URL, 'https://api.kimi.ai/coding/');
  assert.equal(p.kimi.env.ANTHROPIC_API_KEY, 'kimi-literal');
  assert.equal(p.kimi.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'kimi-for-coding');
  assert.equal(p.kimi.models.default, 'k3.1-pro');
});

test('activeProvider falls back to claude', () => {
  const p = defaultProviders();
  assert.equal(activeProvider({ provider: 'bedrock' }, p), p.bedrock);
  assert.equal(activeProvider({}, p), p.claude);
  assert.equal(activeProvider({ provider: 'missing' }, p), p.claude);
});

test('a profile replaces the daemon provider env; claude inherits it', () => {
  const base = {
    PATH: '/bin', HOME: '/h',
    ANTHROPIC_API_KEY: 'old-key', ANTHROPIC_BASE_URL: 'https://old.test', ANTHROPIC_AUTH_TOKEN: 'old-token',
    ANTHROPIC_MODEL: 'old-model', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'old-haiku',
    CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CONFIG_DIR: '/work',
  };
  const p = defaultProviders();
  const custom = providerEnv({ ...p.bedrock, env: { ANTHROPIC_BASE_URL: 'https://new.test' } }, base);
  assert.equal(custom.PATH, '/bin');
  assert.equal(custom.ANTHROPIC_BASE_URL, 'https://new.test');
  assert.equal(custom.ANTHROPIC_API_KEY, undefined);
  assert.equal(custom.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(custom.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(custom.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(custom.ANTHROPIC_MODEL, undefined);
  assert.equal(custom.ANTHROPIC_DEFAULT_HAIKU_MODEL, undefined);

  const login = providerEnv(p.subscription, base);
  assert.equal(login.ANTHROPIC_API_KEY, undefined);
  assert.equal(login.ANTHROPIC_BASE_URL, undefined);

  const inherited = providerEnv(p.claude, base);
  assert.equal(inherited.ANTHROPIC_API_KEY, 'old-key');
  assert.equal(inherited.CLAUDE_CODE_USE_BEDROCK, '1');
  assert.equal(inherited.CLAUDE_CONFIG_DIR, '/work');
  assert.equal(inherited.ANTHROPIC_MODEL, 'old-model');
});

test('Kimi profiles map every Claude Code model tier', () => {
  const p = defaultProviders();

  const kimi = providerEnv(p.kimi, { KIMI_API_KEY: 'kimi-key' });
  assert.equal(kimi.ANTHROPIC_BASE_URL, 'https://api.kimi.ai/coding/');
  assert.equal(kimi.ANTHROPIC_API_KEY, 'kimi-key');
  assert.equal(kimi.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(kimi.ANTHROPIC_MODEL, 'k3');
  assert.equal(kimi.ANTHROPIC_DEFAULT_SONNET_MODEL, 'k3');
  assert.equal(kimi.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'kimi-for-coding');
  assert.equal(kimi.ANTHROPIC_SMALL_FAST_MODEL, 'kimi-for-coding');
  assert.equal(kimi.CLAUDE_CODE_SUBAGENT_MODEL, 'k3');

  const moonshot = providerEnv(p.moonshot, { MOONSHOT_API_KEY: 'ms-key' });
  assert.equal(moonshot.ANTHROPIC_BASE_URL, 'https://api.moonshot.ai/anthropic');
  assert.equal(moonshot.ANTHROPIC_AUTH_TOKEN, 'ms-key');
  assert.equal(moonshot.ANTHROPIC_API_KEY, undefined);
  assert.equal(moonshot.ANTHROPIC_MODEL, 'kimi-k3[1m]');
  assert.equal(moonshot.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'kimi-k2.6');
});

test('OpenRouter profile blanks the Anthropic key and maps tiers', () => {
  const env = providerEnv(defaultProviders().openrouter, { OPENROUTER_API_KEY: 'sk-or-test', ANTHROPIC_API_KEY: 'stale' });
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://openrouter.ai/api');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-or-test');
  assert.equal(env.ANTHROPIC_API_KEY, '');
  assert.equal(env.ANTHROPIC_MODEL, 'anthropic/claude-sonnet-4.6');
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'anthropic/claude-haiku-4.5');
  assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, 'anthropic/claude-haiku-4.5');
  assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, 'anthropic/claude-sonnet-4.6');
});

test('explicit tier models win; unset still wins', () => {
  const env = providerEnv({
    env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'fast-model' },
    models: { default: 'main-model' },
  }, {});
  assert.equal(env.ANTHROPIC_MODEL, 'main-model');
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'fast-model');
  assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, 'fast-model');

  const unset = providerEnv({ models: { default: 'main-model' }, unset: ['ANTHROPIC_MODEL'] }, {});
  assert.equal(unset.ANTHROPIC_MODEL, undefined);
  assert.equal(unset.ANTHROPIC_DEFAULT_SONNET_MODEL, 'main-model');
});

test('${VAR} values are read from the daemon environment', () => {
  const base = { ZAI_API_KEY: 'zai-secret' };
  assert.equal(providerEnv({ env: { ANTHROPIC_AUTH_TOKEN: '${ZAI_API_KEY}' } }, base).ANTHROPIC_AUTH_TOKEN, 'zai-secret');
});

test('a missing ${VAR} is reported with the variable name', () => {
  assert.throws(() => providerEnv({ env: { ANTHROPIC_AUTH_TOKEN: '${AGENTHERD_TEST_UNSET_12345}' } }, {}),
    /AGENTHERD_TEST_UNSET_12345.*not set/);
});

test('model overrides: role first, then default, then the built-in role model', () => {
  const profile = { models: { default: 'glm-4.6', researcher: 'glm-4.5-air' } };
  assert.equal(providerModel(profile, ROLES.researcher), 'glm-4.5-air');
  assert.equal(providerModel(profile, ROLES.qa), 'glm-4.6');
  assert.equal(providerModel({ models: {} }, ROLES.qa), ROLES.qa.model);
});

test('invalid providers.json is rejected with a useful error', () => {
  const cases = [
    ['{oops', /not valid JSON/],
    [JSON.stringify({}), /must have a "profiles" object/],
    [JSON.stringify({ profiles: { x: 5 } }), /profile "x" must be an object/],
    [JSON.stringify({ profiles: { x: { env: { A: 5 } } } }), /env\.A must be a string/],
    [JSON.stringify({ profiles: { x: { unset: 'A' } } }), /unset must be an array/],
    ['{"profiles":{"__proto__":{}}}', /reserved/],
    [JSON.stringify({ profiles: { 'bad name': {} } }), /may only contain/],
  ];
  for (const [text, re] of cases) {
    const folder = tmp();
    fs.mkdirSync(path.join(folder, '.agentherd'), { recursive: true });
    fs.writeFileSync(path.join(folder, '.agentherd', 'providers.json'), text);
    assert.throws(() => loadProviders(folder), re);
  }
});
