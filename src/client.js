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
  if (!readDaemon(folder)) {
    spawn(process.execPath, [daemonPath, folder], { detached: true, stdio: 'ignore', env: process.env }).unref();
  }
  for (let i = 0; i < 50; i++) {
    const d = readDaemon(folder);
    if (d) return { port: d.port };
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('daemon did not start');
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
    req.end(data);
  });
}

export function subscribe(port, onState) {
  let closed = false, req;
  const connect = () => {
    req = http.get({ host: '127.0.0.1', port, path: '/api/events' }, (res) => {
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
  const retry = () => { if (!closed) setTimeout(connect, 1000); };
  connect();
  return () => { closed = true; req.destroy(); };
}
