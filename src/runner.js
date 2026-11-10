import { spawn } from 'node:child_process';
import { SCHEMAS } from './roles.js';
import { providerEnv, providerModel } from './providers.js';

// Agents pipe output through cat/head/tail/grep; in dontAsk mode one unlisted part denies the whole command.
const READ_ONLY = ['Read', 'Glob', 'Grep', 'Bash(git log*)', 'Bash(git diff*)', 'Bash(git status*)',
  'Bash(ls *)', 'Bash(cat *)', 'Bash(head *)', 'Bash(tail *)', 'Bash(grep *)', 'Bash(wc *)', 'Bash(sed -n *)'];
const WORKER_TOOLS = [...READ_ONLY, 'Edit', 'Write', 'Bash(npm *)', 'Bash(npx *)', 'Bash(node *)', 'Bash(cargo *)', 'WebSearch', 'WebFetch'];

export function buildArgs(role, prompt, model = role.model) {
  return [
    '-p', prompt,
    '--model', model,
    '--output-format', 'stream-json', '--verbose',
    '--json-schema', JSON.stringify(SCHEMAS[role.kind]),
    '--append-system-prompt', role.prompt,
    '--permission-mode', 'dontAsk',
    '--allowedTools', ...(role.kind === 'worker' ? WORKER_TOOLS : READ_ONLY),
  ];
}

export function parseLine(line) {
  let m;
  try { m = JSON.parse(line); } catch { return {}; }
  if (m?.type === 'result') return { result: m };
  if (m?.type === 'assistant') {
    const tu = m.message?.content?.find?.((c) => c.type === 'tool_use');
    if (tu) {
      const i = tu.input ?? {};
      return { activity: `${tu.name} ${i.file_path ?? i.command ?? i.pattern ?? ''}`.slice(0, 120) };
    }
  }
  return {};
}

export const isLimitError = (r) =>
  !!(r.is_error && /usage limit|rate limit|session limit|limit reached|out of usage|quota/i.test(r.result ?? ''));

const zoneParts = (zone, ms) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const p = {};
  for (const { type, value } of parts) if (type !== 'literal') p[type] = Number(value);
  return p;
};

// The UTC timestamp for a wall-clock time in an IANA zone (works across DST).
const zonedToUtc = (year, month, day, hour, minute, zone) => {
  const want = Date.UTC(year, month - 1, day, hour, minute);
  let ts = want;
  for (let i = 0; i < 3; i++) {
    const p = zoneParts(zone, ts);
    const diff = want - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    if (diff === 0) break;
    ts += diff;
  }
  return ts;
};

// "You've hit your session limit · resets 4pm (Europe/Berlin)" → next 4pm in that zone.
export function limitResetAt(text, now = Date.now()) {
  const m = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i.exec(String(text ?? ''));
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] === undefined ? 0 : Number(m[2]);
  const meridiem = m[3]?.toLowerCase();
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem === 'pm' ? 12 : 0);
  } else if (hour > 23) return null;

  const zone = m[4]?.trim();
  if (!zone) {
    const d = new Date(now);
    const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute).getTime();
    return at > now ? at : new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, hour, minute).getTime();
  }
  try {
    const p = zoneParts(zone, now);
    let at = zonedToUtc(p.year, p.month, p.day, hour, minute, zone);
    if (at <= now) {
      const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
      at = zonedToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), hour, minute, zone);
    }
    return at;
  } catch {
    return null;
  }
}

export function runAgent({ role, prompt, cwd, onActivity, provider }) {
  const env = provider ? providerEnv(provider) : { ...process.env };
  const model = provider ? providerModel(provider, role) : role.model;
  const child = spawn(process.env.AGENTHERD_CLAUDE ?? 'claude', buildArgs(role, prompt, model), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let killed = false, buf = '', stderr = '', result = null;
  const handle = (line) => {
    const p = parseLine(line);
    if (p.activity) onActivity?.(p.activity);
    if (p.result) result = p.result;
  };
  child.stdout.on('data', (d) => {
    buf += d;
    const lines = buf.split('\n');
    buf = lines.pop();
    lines.forEach(handle);
  });
  child.stderr.on('data', (d) => { stderr += d; });
  const promise = new Promise((resolve) => {
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('close', (code) => {
      if (buf) handle(buf);
      if (killed) return resolve({ ok: false, error: 'killed' });
      const success = !!(result?.structured_output && !result.is_error);
      const limitText = [result?.result, stderr].filter(Boolean).join('\n');
      // some CLI versions report the limit only on stderr, with no result line
      if (isLimitError({ is_error: !success, result: limitText })) {
        return resolve({ ok: false, limit: true, resumeAt: limitResetAt(limitText) });
      }
      if (success) return resolve({ ok: true, output: result.structured_output });
      resolve({ ok: false, error: result?.result || stderr.trim().slice(-500) || `exit code ${code}` });
    });
  });
  return { promise, kill() { killed = true; child.kill('SIGTERM'); } };
}
