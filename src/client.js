import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const daemonPath = new URL('./daemon.js', import.meta.url).pathname;
const file = (folder) => path.join(folder, '.agentherd', 'daemon.json');

export function readDaemon(folder) {
  let d;
  try { d = JSON.parse(fs.readFileSync(file(folder), 'utf8')); } catch { return null; }
  try { process.kill(d.pid, 0); return d; } catch (e) {
    if (e.code === 'EPERM') return d;
    fs.rmSync(file(folder), { force: true });
    return null;
  }
}

export async function ensureDaemon(folder) {
  const logFile = path.join(folder, '.agentherd', 'daemon.log');
  let exited = false;
  if (!readDaemon(folder)) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const fd = fs.openSync(logFile, 'a');
    const child = spawn(process.execPath, [daemonPath, folder], { detached: true, stdio: ['ignore', fd, fd], env: process.env });
    fs.closeSync(fd);
    child.on('exit', () => { exited = true; });
    child.unref();
  }
  for (let i = 0; i < 50 && !exited; i++) {
    const d = readDaemon(folder);
    if (d) return { port: d.port };
    await new Promise((r) => setTimeout(r, 100));
  }
  let tail = '';
  try { tail = fs.readFileSync(logFile, 'utf8').trimEnd().split('\n').slice(-10).join('\n'); } catch {}
  throw new Error(`daemon did not start${tail ? ` (${logFile}):\n${tail}` : ''}`);
}

// Only one team runs at a time (they share one subscription): stop teams in other folders.
// Scans the daemon's port range (daemon.js: 4321..4340).
const PORTS = Array.from({ length: 20 }, (_, i) => 4321 + i);
export async function stopOtherTeams(folder, ports = PORTS) {
  const stopped = [];
  for (const port of ports) {
    const s = await api(port, 'GET', '/api/state').catch(() => null);
    if (!s?.folder || path.resolve(s.folder) === path.resolve(folder)) continue;
    await api(port, 'POST', '/api/control', { action: 'stop' }).catch(() => {});
    stopped.push(s.folder);
  }
  return stopped;
}

export function api(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath,
      headers: { 'Content-Type': 'application/json', ...(data && { 'Content-Length': Buffer.byteLength(data) }) } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        let json; try { json = JSON.parse(b); } catch { json = null; }
        resolve(Object.assign(json ?? {}, { _status: res.statusCode }));
      });
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('timeout')));
    req.end(data);
  });
}

export function subscribe(port, onState, onStatus = () => {}) {
  let closed = false, req, timer, status;
  const report = (s) => { if (!closed && s !== status) { status = s; onStatus(s); } };
  const connect = () => {
    req = http.get({ host: '127.0.0.1', port, path: '/api/events' }, (res) => {
      report('connected');
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          if (chunk.startsWith('data: ')) try { onState(JSON.parse(chunk.slice(6))); } catch {}
        }
      });
      res.on('end', retry);
    });
    req.on('error', retry);
  };
  const retry = () => {
    report('disconnected');
    if (!closed) { clearTimeout(timer); timer = setTimeout(connect, 1000); }
  };
  connect();
  return () => { closed = true; clearTimeout(timer); req.destroy(); };
}
