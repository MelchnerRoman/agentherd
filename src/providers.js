import fs from 'node:fs';
import path from 'node:path';

// Claude Code reads its endpoint and credentials from these. A profile that does
// not inherit the daemon env starts from a clean slate so providers cannot mix.
export const PROVIDER_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
  'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CONFIG_DIR',
];

// Claude Code asks for these model tiers internally (main loop, background
// summaries, sub-agents). Third-party endpoints only know their own model names.
const TIER_ENV_KEYS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
];

const BUILTINS = {
  claude: { label: 'Claude Code default (current login/env)', inherit: true },
  subscription: { label: 'Claude subscription (ignore API key)' },
  anthropic: { label: 'Anthropic API key', env: { ANTHROPIC_API_KEY: '${ANTHROPIC_API_KEY}' } },
  bedrock: { label: 'Amazon Bedrock', env: { CLAUDE_CODE_USE_BEDROCK: '1' } },
  vertex: { label: 'Google Vertex AI', env: { CLAUDE_CODE_USE_VERTEX: '1' } },
  kimi: {
    label: 'Kimi Code (subscription)',
    env: {
      ANTHROPIC_BASE_URL: 'https://api.kimi.ai/coding/',
      ANTHROPIC_API_KEY: '${KIMI_API_KEY}',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'kimi-for-coding',
      CLAUDE_CODE_EFFORT_LEVEL: 'high',
    },
    models: { default: 'k3' },
  },
  moonshot: {
    label: 'Moonshot API (Kimi)',
    env: {
      ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic',
      ANTHROPIC_AUTH_TOKEN: '${MOONSHOT_API_KEY}',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'kimi-k2.6',
      CLAUDE_CODE_EFFORT_LEVEL: 'max',
    },
    models: { default: 'kimi-k3[1m]' },
  },
  openrouter: {
    label: 'OpenRouter',
    env: {
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
      // OpenRouter needs this explicitly empty, not merely unset.
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: '${OPENROUTER_API_KEY}',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'anthropic/claude-haiku-4.5',
    },
    models: { default: 'anthropic/claude-sonnet-4.6' },
  },
};

const configPath = (folder) => path.join(folder, '.agentherd', 'providers.json');
const clone = (p) => ({
  label: p.label,
  ...(p.inherit ? { inherit: true } : {}),
  env: { ...(p.env ?? {}) },
  models: { ...(p.models ?? {}) },
  unset: [...(p.unset ?? [])],
});

export function defaultProviders() {
  return Object.fromEntries(Object.entries(BUILTINS).map(([name, p]) => [name, clone(p)]));
}

const fail = (msg) => { throw new Error(`.agentherd/providers.json: ${msg}`); };

function checkProfile(name, p, base) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) fail(`profile "${name}" must be an object`);
  if (p.label !== undefined && typeof p.label !== 'string') fail(`profile "${name}": label must be a string`);
  if (p.inherit !== undefined && typeof p.inherit !== 'boolean') fail(`profile "${name}": inherit must be true or false`);
  for (const key of ['env', 'models']) {
    if (p[key] !== undefined && (!p[key] || typeof p[key] !== 'object' || Array.isArray(p[key]))) fail(`profile "${name}": ${key} must be an object`);
    for (const [k, v] of Object.entries(p[key] ?? {})) {
      if (!k || typeof v !== 'string') fail(`profile "${name}": ${key}.${k || '?'} must be a string`);
    }
  }
  if (p.unset !== undefined && (!Array.isArray(p.unset) || p.unset.some((k) => typeof k !== 'string' || !k))) fail(`profile "${name}": unset must be an array of names`);
  if (!base) return clone(p);
  // A project file extends a built-in instead of replacing it, so overriding
  // only the key or model keeps the endpoint and tier mapping.
  return clone({
    label: p.label ?? base.label,
    inherit: p.inherit ?? base.inherit,
    env: { ...(base.env ?? {}), ...(p.env ?? {}) },
    models: { ...(base.models ?? {}), ...(p.models ?? {}) },
    unset: [...new Set([...(base.unset ?? []), ...(p.unset ?? [])])],
  });
}

export function loadProviders(folder) {
  const providers = defaultProviders();
  let text;
  try { text = fs.readFileSync(configPath(folder), 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return providers;
    throw e;
  }
  let data;
  try { data = JSON.parse(text); } catch (e) { fail(`not valid JSON (${e.message})`); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('must be a JSON object');
  if (!data.profiles || typeof data.profiles !== 'object' || Array.isArray(data.profiles)) fail('must have a "profiles" object');
  for (const [name, p] of Object.entries(data.profiles)) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) fail(`profile name "${name}" may only contain letters, digits, dot, dash and underscore`);
    if (['__proto__', 'constructor', 'prototype'].includes(name)) fail(`profile name "${name}" is reserved`);
    providers[name] = checkProfile(name, p, providers[name]);
  }
  return providers;
}

const expand = (value, base, where) => value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
  if (!(name in base)) throw new Error(`${where} references \${${name}}, which is not set in the daemon environment; export it and restart agentherd, or put the value in providers.json`);
  return base[name];
});

export function providerEnv(profile, base = process.env) {
  const env = { ...base };
  if (!profile.inherit) for (const key of PROVIDER_ENV_KEYS) delete env[key];
  for (const [key, value] of Object.entries(profile.env ?? {})) env[key] = expand(value, base, `provider env ${key}`);

  // Point every unset Claude Code tier at the provider's model. Without this,
  // background summaries and sub-agents ask a third-party endpoint for
  // "haiku"/"sonnet" and fail even though the main run works.
  const model = profile.models?.default;
  if (model) {
    for (const key of TIER_ENV_KEYS) {
      if (!(key in (profile.env ?? {}))) env[key] = model;
    }
    if (!('ANTHROPIC_SMALL_FAST_MODEL' in (profile.env ?? {}))) {
      env.ANTHROPIC_SMALL_FAST_MODEL = env.ANTHROPIC_DEFAULT_HAIKU_MODEL || model;
    }
  }

  for (const key of profile.unset ?? []) delete env[key];
  return env;
}

export function providerModel(profile, role) {
  return profile.models?.[role.id] ?? profile.models?.default ?? role.model;
}

export function activeProvider(state, providers) {
  return providers[state.provider] ?? providers.claude ?? Object.values(providers)[0];
}

export function providerList(providers) {
  return Object.entries(providers).map(([name, p]) => ({ name, label: p.label || name }));
}
