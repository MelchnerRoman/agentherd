import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { loadState, saveState, counts, log } from './store.js';
import { prepareRepo } from './git.js';
import { createOrchestrator } from './orchestrator.js';
import { defaultProviders, loadProviders, providerEnv, providerList } from './providers.js';

const folder = path.resolve(process.argv[2] ?? '');
const state = loadState(folder);
if (!state) {
  console.error(`agentherd: no state in ${folder}/.agentherd/state.json`);
  process.exit(1);
}
if (state.status === 'stopped') state.status = 'running';
prepareRepo(folder);

const daemonFile = path.join(folder, '.agentherd', 'daemon.json');
const clients = new Set();
let providers;
try { providers = loadProviders(folder); } catch (e) {
  providers = defaultProviders();
  log(state, 'agentHerd', `provider config ignored: ${e.message}`);
  saveState(state);
}
state.provider ??= 'claude';
if (!Object.hasOwn(providers, state.provider)) {
  log(state, 'agentHerd', `provider "${state.provider}" is not configured; using claude`);
  state.provider = 'claude';
}
try { providerEnv(providers[state.provider]); } catch (e) {
  log(state, 'agentHerd', `provider "${state.provider}" is not usable (${e.message}); using claude`);
  state.provider = 'claude';
}
let timer = null;
const payload = () => JSON.stringify({
  ...state, counts: counts(state), providers: providerList(providers), providerLabel: providers[state.provider]?.label,
});
const push = () => { // throttle SSE to 4/s, trailing edge
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const msg = `data: ${payload()}\n\n`;
    for (const res of clients) res.write(msg);
  }, 250);
};
const orch = createOrchestrator(state, { onChange: push, providers });

const send = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};
const MAX_BODY = 64 * 1024;
const readJson = (req) => new Promise((resolve, reject) => {
  let b = '';
  req.on('data', (c) => {
    b += c;
    if (b.length > MAX_BODY) { reject(Object.assign(new Error('body too large'), { status: 413 })); b = ''; }
  });
  req.on('end', () => {
    try {
      const v = b ? JSON.parse(b) : {};
      if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error();
      resolve(v);
    } catch { reject(Object.assign(new Error('bad json'), { status: 400 })); }
  });
});

function shutdown() {
  orch.stopAll();
  saveState(state);
  fs.rmSync(daemonFile, { force: true });
  process.exit(0);
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  try {
    // DNS rebinding / CSRF: only our own origin, and only JSON posts (forms can't send that cross-site)
    const port = server.address().port;
    if (![`localhost:${port}`, `127.0.0.1:${port}`].includes(req.headers.host)) return send(res, 403, { error: 'forbidden host' });
    if (req.method === 'POST' && (req.headers['content-type'] ?? '').split(';')[0].trim() !== 'application/json') return send(res, 415, { error: 'expected application/json' });
    if (req.method === 'GET' && pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(new URL('../web/index.html', import.meta.url)));
    }
    if (req.method === 'GET' && pathname === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(payload());
    }
    if (req.method === 'GET' && pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: ${payload()}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'POST' && (pathname === '/api/message' || pathname === '/api/control')) {
      let body;
      try { body = await readJson(req); } catch (e) {
        if (e.status === 413) { res.setHeader('Connection', 'close'); req.resume(); }
        return send(res, e.status ?? 400, { error: e.message });
      }
      if (pathname === '/api/message') {
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (!text) return send(res, 400, { error: 'empty text' });
        state.messages.push({ text, t: Date.now(), read: false });
        state.leadIdle = false;
        log(state, 'Product owner', text);
        saveState(state);
        push();
        send(res, 200, { ok: true });
        return orch.tick();
      }
      const { action, maxAgents, provider } = body;
      if (action !== undefined && !['pause', 'resume', 'stop'].includes(action)) return send(res, 400, { error: 'unknown action' });
      if (maxAgents !== undefined && !(Number.isInteger(maxAgents) && maxAgents >= 1 && maxAgents <= 6)) return send(res, 400, { error: 'maxAgents must be 1..6' });
      if (provider !== undefined && (typeof provider !== 'string' || !Object.hasOwn(providers, provider))) return send(res, 400, { error: 'unknown provider' });
      if (provider !== undefined) {
        try { providerEnv(providers[provider]); } catch (e) { return send(res, 400, { error: e.message }); }
      }
      if (action === undefined && maxAgents === undefined && provider === undefined) return send(res, 400, { error: 'nothing to do' });
      if (maxAgents !== undefined) state.maxAgents = maxAgents;
      if (action === 'pause') state.status = 'paused';
      if (action === 'resume') state.status = 'running';
      if (action === 'stop') state.status = 'stopped';
      if (provider !== undefined) {
        state.provider = provider;
        log(state, 'agentHerd', `provider switched to ${providers[provider].label || provider}`);
      }
      saveState(state);
      push();
      if (action === 'stop') { res.on('finish', shutdown); return send(res, 200, { ok: true }); }
      send(res, 200, { ok: true });
      return orch.tick();
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    if (!res.headersSent) send(res, 500, { error: String(e.message) });
  }
});

let port = 4321;
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && port < 4340) server.listen(++port, '127.0.0.1');
  else { console.error(e); process.exit(1); }
});
server.on('listening', () => {
  fs.mkdirSync(path.dirname(daemonFile), { recursive: true });
  fs.writeFileSync(daemonFile, JSON.stringify({ pid: process.pid, port: server.address().port }));
  orch.recover();
  orch.tick();
  setInterval(() => orch.tick(), 5000);
});
// stderr goes to .agentherd/daemon.log; the activity feed is what the owner actually sees
const report = (kind) => (e) => {
  console.error(`${new Date().toISOString()} ${kind}:`, e);
  try { log(state, 'agentHerd', `internal error: ${e?.message ?? e}`); saveState(state); } catch {}
};
process.on('unhandledRejection', report('unhandledRejection'));
process.on('uncaughtException', (e) => { report('uncaughtException')(e); shutdown(); });
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
server.listen(port, '127.0.0.1');
