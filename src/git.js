import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const IDENT = ['-c', 'user.name=agentHerd', '-c', 'user.email=agentherd@local'];
const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ok = (cwd, ...args) => { try { run(cwd, ...args); return true; } catch { return false; } };
const wtRoot = (folder) => path.join(folder, '.agentherd', 'worktrees');

export const mainWorktreePath = (folder) => path.join(wtRoot(folder), '_main');

function addWorktree(folder, dir, branch, from) {
  if (fs.existsSync(dir)) return;
  fs.mkdirSync(wtRoot(folder), { recursive: true });
  if (ok(folder, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`)) run(folder, 'worktree', 'add', dir, branch);
  else run(folder, 'worktree', 'add', '-b', branch, dir, from);
}

export function prepareRepo(folder) {
  if (!fs.existsSync(path.join(folder, '.git'))) run(folder, 'init');
  if (!ok(folder, 'rev-parse', '--verify', '-q', 'HEAD')) run(folder, ...IDENT, 'commit', '--allow-empty', '-m', 'chore: agentherd initial commit');
  const exclude = path.resolve(folder, run(folder, 'rev-parse', '--git-path', 'info/exclude'));
  const cur = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  if (!cur.split('\n').includes('.agentherd/')) {
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, (cur && !cur.endsWith('\n') ? '\n' : '') + '.agentherd/\n');
  }
  if (!ok(folder, 'rev-parse', '--verify', '-q', 'refs/heads/agentherd')) run(folder, 'branch', 'agentherd', 'HEAD');
  const main = mainWorktreePath(folder);
  addWorktree(folder, main, 'agentherd');
  return main;
}

export function taskWorktree(folder, taskId) {
  const dir = path.join(wtRoot(folder), `T${taskId}`);
  addWorktree(folder, dir, `task-${taskId}`, 'agentherd');
  return dir;
}

export function commitAll(dir, message) {
  run(dir, 'add', '-A');
  if (ok(dir, 'diff', '--cached', '--quiet')) return null;
  run(dir, ...IDENT, 'commit', '-m', message);
  return run(dir, 'rev-parse', '--short', 'HEAD');
}

export const diffVsIntegration = (dir) => run(dir, 'diff', 'agentherd...HEAD');

export function mergeTask(folder, taskId, title) {
  const main = mainWorktreePath(folder);
  try {
    run(main, ...IDENT, 'merge', '--no-ff', `task-${taskId}`, '-m', `T${taskId}: ${title}`);
  } catch {
    ok(main, 'merge', '--abort');
    return { ok: false, conflict: true };
  }
  return { ok: true, commit: run(main, 'rev-parse', '--short', 'HEAD') };
}

export function removeTaskWorktree(folder, taskId) {
  run(folder, 'worktree', 'remove', '--force', path.join(wtRoot(folder), `T${taskId}`));
  run(folder, 'branch', '-D', `task-${taskId}`);
}
