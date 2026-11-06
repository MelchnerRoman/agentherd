import readline from 'node:readline';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { ROLES } from './roles.js';
import { counts } from './store.js';
import { api, subscribe } from './client.js';

const clip = (s, w) => (s.length > w ? s.slice(0, Math.max(0, w)) : s);
const hhmm = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

export function renderView(state, { width, height }) {
  const c = state.counts ?? counts(state);
  const working = Object.values(state.agents).filter((a) => a.status === 'working').length;
  const status = state.status === 'limited'
    ? `paused – usage limit, resumes ${state.resumeAt ? hhmm(state.resumeAt) : '?'}`
    : state.status;
  const lines = [
    `agentHerd · ${path.basename(state.folder)} · ${status} · agents ${working}/${state.maxAgents}`,
    `Backlog ${c.backlog} · In progress ${c.in_progress} · Review ${c.review} · Done ${c.done} · Blocked ${c.blocked}`,
  ];
  const nameW = Math.max(...Object.values(ROLES).map((r) => r.name.length));
  for (const [id, r] of Object.entries(ROLES)) {
    const a = state.agents[id] ?? { status: 'idle' };
    const t = a.status === 'working' && state.tasks.find((x) => x.id === a.taskId);
    lines.push(a.status === 'working'
      ? `● ${r.name.padEnd(nameW)}  ${t ? `T${t.id} ${t.title}` : 'working'}`
      : `○ ${r.name.padEnd(nameW)}  idle`);
  }
  const feed = Math.max(0, height - lines.length - 2);
  const act = feed ? state.activity.slice(-feed) : [];
  for (const a of act) lines.push(`${hhmm(a.t)} ${a.agent}: ${a.text}`.replace(/\s+/g, ' '));
  return lines.map((l) => clip(l, width)).join('\n');
}

const HELP = 'Type a wish for the team, or: /pause /resume /stop /tasks /task <id> /agents <n> /web /quit /help';

function tasksText(state) {
  const out = [];
  for (const s of ['backlog', 'in_progress', 'review', 'done', 'blocked']) {
    const ts = state.tasks.filter((t) => t.status === s);
    out.push(`${s} (${ts.length})`, ...ts.map((t) => `  T${t.id} [${t.role}] ${t.title}`));
  }
  return out.join('\n');
}

function taskText(state, id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return `No task T${id}.`;
  const notes = [].concat(t.notes ?? []).map((n) => `  - ${typeof n === 'string' ? n : JSON.stringify(n)}`);
  return [`T${t.id} ${t.title}`, `status ${t.status} · role ${t.role} · attempts ${t.attempts} · review rounds ${t.reviewRounds}${t.commit ? ` · commit ${t.commit}` : ''}`,
    t.description ?? '', ...(notes.length ? ['notes:', ...notes] : [])].join('\n');
}

export function openUrl(url) {
  execFile('open', [url], () => {});
}

export function startTui(port, folder) {
  const out = process.stdout;
  let state = null, page = null, flash = '', timer = null, last = 0;
  const rl = readline.createInterface({ input: process.stdin, output: out, prompt: '> ' });

  const draw = () => {
    timer = null; last = Date.now();
    if (page !== null) return;
    const body = state ? renderView(state, { width: out.columns || 80, height: out.rows || 24 }) : 'Connecting…';
    out.write('\x1b[H\x1b[2J' + body + '\n' + (flash ? clip(flash, out.columns || 80) + '\n' : ''));
    rl.prompt(true);
  };
  const schedule = () => { if (!timer) timer = setTimeout(draw, Math.max(0, 250 - (Date.now() - last))); };
  const say = (m) => { flash = m; schedule(); };

  const unsub = subscribe(port, (s) => { state = s; schedule(); });
  let done = false;
  const detach = (msg, code = 0) => {
    if (done) return;
    done = true;
    unsub(); clearTimeout(timer); rl.close();
    out.write('\x1b[H\x1b[2J' + msg + '\n');
    process.exit(code);
  };
  const post = async (p, body) => {
    try {
      const r = await api(port, 'POST', p, body);
      return r._status >= 400 ? (r.error ?? `error ${r._status}`) : null;
    } catch (e) { return `daemon unreachable: ${e.message}`; }
  };

  rl.on('SIGINT', () => detach('Team keeps working in the background. Run agentherd again to watch.'));
  rl.on('close', () => detach('Team keeps working in the background. Run agentherd again to watch.'));
  rl.on('line', async (raw) => {
    const line = raw.trim();
    if (page !== null) { if (!line) { page = null; draw(); } return; }
    if (!line) return;
    if (!line.startsWith('/')) return say((await post('/api/message', { text: line })) ?? '→ sent to team');
    const [cmd, arg] = line.split(/\s+/);
    const show = (text) => { page = text; out.write('\x1b[H\x1b[2J' + text + '\n\n(Enter to return)\n'); rl.prompt(true); };
    switch (cmd) {
      case '/pause': case '/resume': return say((await post('/api/control', { action: cmd.slice(1) })) ?? (cmd === '/pause' ? 'Paused.' : 'Resumed.'));
      case '/stop': {
        const e = await post('/api/control', { action: 'stop' });
        return e ? say(e) : detach('Team stopped.');
      }
      case '/agents': return say((await post('/api/control', { maxAgents: Number(arg) })) ?? `Max agents set to ${arg}.`);
      case '/tasks': return show(state ? tasksText(state) : 'No state yet.');
      case '/task': return show(state ? taskText(state, Number(String(arg ?? '').replace(/^T/i, ''))) : 'No state yet.');
      case '/web': openUrl(`http://localhost:${port}`); return say(`Opening http://localhost:${port}`);
      case '/quit': return detach('Team keeps working in the background. Run agentherd again to watch.');
      default: return say(HELP);
    }
  });
  out.on('resize', schedule);
  draw();
}
