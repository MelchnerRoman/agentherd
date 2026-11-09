import { spawn } from 'node:child_process';
import { SCHEMAS } from './roles.js';

// Agents pipe output through cat/head/tail/grep; in dontAsk mode one unlisted part denies the whole command.
const READ_ONLY = ['Read', 'Glob', 'Grep', 'Bash(git log*)', 'Bash(git diff*)', 'Bash(git status*)',
  'Bash(ls *)', 'Bash(cat *)', 'Bash(head *)', 'Bash(tail *)', 'Bash(grep *)', 'Bash(wc *)', 'Bash(sed -n *)'];
const WORKER_TOOLS = [...READ_ONLY, 'Edit', 'Write', 'Bash(npm *)', 'Bash(npx *)', 'Bash(node *)'];

export function buildArgs(role, prompt) {
  return [
    '-p', prompt,
    '--model', role.model,
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
  !!(r.is_error && /usage limit|rate limit|limit reached|out of usage/i.test(r.result ?? ''));

export function runAgent({ role, prompt, cwd, onActivity }) {
  const child = spawn(process.env.AGENTHERD_CLAUDE ?? 'claude', buildArgs(role, prompt), { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
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
      if (result && isLimitError(result)) return resolve({ ok: false, limit: true });
      if (result?.structured_output && !result.is_error) return resolve({ ok: true, output: result.structured_output });
      resolve({ ok: false, error: result?.result || stderr.trim().slice(-500) || `exit code ${code}` });
    });
  });
  return { promise, kill() { killed = true; child.kill('SIGTERM'); } };
}
