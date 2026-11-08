import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { prepareRepo, mainWorktreePath, taskWorktree, commitAll, diffVsIntegration, mergeTask, removeTaskWorktree, commitsAhead } from '../src/git.js';

const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
const git = (cwd, ...args) => execFileSync('git', [...ID, ...args], { cwd, encoding: 'utf8' }).trim();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ah-'));

test('prepareRepo on fresh state drops stale task branches', () => {
  const f = tmp();
  prepareRepo(f);
  const t1 = taskWorktree(f, 1);
  fs.writeFileSync(path.join(t1, 'old.txt'), 'old');
  commitAll(t1, 'old work');
  git(f, 'branch', 'task-1-conflict-1', 'task-1');
  git(f, 'branch', 'task-foo', 'task-1');
  fs.rmSync(path.join(f, '.agentherd'), { recursive: true });
  prepareRepo(f);
  assert.equal(git(f, 'branch', '--list', 'task-1'), '');
  assert.notEqual(git(f, 'branch', '--list', 'task-1-conflict-1'), '');
  assert.notEqual(git(f, 'branch', '--list', 'task-foo'), '');
  assert.equal(commitsAhead(taskWorktree(f, 1)), 0);
});

test('prepareRepo on plain folder', () => {
  const f = tmp();
  const main = prepareRepo(f);
  assert.equal(main, mainWorktreePath(f));
  assert.ok(fs.existsSync(path.join(f, '.git')));
  assert.notEqual(git(f, 'branch', '--list', 'agentherd'), '');
  assert.match(fs.readFileSync(path.join(f, '.git/info/exclude'), 'utf8'), /\.agentherd\//);
  assert.equal(git(f, 'status', '--porcelain'), '');
});

test("prepareRepo leaves user's branch and dirty files alone", () => {
  const f = tmp();
  git(f, 'init', '-b', 'main');
  fs.writeFileSync(path.join(f, 'a.txt'), 'one');
  git(f, 'add', '-A');
  git(f, 'commit', '-m', 'a');
  fs.writeFileSync(path.join(f, 'a.txt'), 'dirty');
  prepareRepo(f);
  assert.equal(git(f, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(fs.readFileSync(path.join(f, 'a.txt'), 'utf8'), 'dirty');
});

test('prepareRepo is idempotent', () => {
  const f = tmp();
  prepareRepo(f);
  prepareRepo(f);
});

test('task flow', () => {
  const f = tmp();
  prepareRepo(f);
  const wt = taskWorktree(f, 1);
  assert.equal(taskWorktree(f, 1), wt);
  fs.writeFileSync(path.join(wt, 'x.txt'), 'x');
  assert.match(commitAll(wt, 'T1: x'), /^[0-9a-f]+$/);
  assert.match(diffVsIntegration(wt), /x\.txt/);
  const r = mergeTask(f, 1, 'x');
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(path.join(mainWorktreePath(f), 'x.txt')));
  removeTaskWorktree(f, 1);
  assert.ok(!fs.existsSync(wt));
  assert.equal(git(f, 'branch', '--list', 'task-1'), '');
});

test('commitAll with no changes returns null', () => {
  const f = tmp();
  prepareRepo(f);
  assert.equal(commitAll(taskWorktree(f, 1), 'nothing'), null);
});

test('merge conflict', () => {
  const f = tmp();
  prepareRepo(f);
  const w0 = taskWorktree(f, 0);
  fs.writeFileSync(path.join(w0, 'y.txt'), 'base\n');
  commitAll(w0, 'y');
  assert.equal(mergeTask(f, 0, 'y').ok, true);
  const w1 = taskWorktree(f, 1);
  const w2 = taskWorktree(f, 2);
  git(w1, 'merge', 'agentherd');
  git(w2, 'merge', 'agentherd');
  fs.writeFileSync(path.join(w1, 'y.txt'), 'one\n');
  fs.writeFileSync(path.join(w2, 'y.txt'), 'two\n');
  commitAll(w1, 'one');
  commitAll(w2, 'two');
  assert.equal(mergeTask(f, 1, 'one').ok, true);
  assert.deepEqual(mergeTask(f, 2, 'two'), { ok: false, conflict: true });
  const gitDir = git(mainWorktreePath(f), 'rev-parse', '--git-dir');
  assert.ok(!fs.existsSync(path.resolve(mainWorktreePath(f), gitDir, 'MERGE_HEAD')));
});

test('prepareRepo on non-git folder with code commits that code', () => {
  const f = tmp();
  fs.writeFileSync(path.join(f, 'app.js'), 'x');
  fs.mkdirSync(path.join(f, 'node_modules'));
  fs.writeFileSync(path.join(f, 'node_modules', 'dep.js'), 'x');
  fs.mkdirSync(path.join(f, '.agentherd'));
  fs.writeFileSync(path.join(f, '.agentherd', 'state.json'), '{}');
  prepareRepo(f);
  const wt = taskWorktree(f, 1);
  assert.ok(fs.existsSync(path.join(wt, 'app.js')));
  assert.equal(git(f, 'ls-tree', '-r', '--name-only', 'agentherd'), 'app.js');
  assert.match(fs.readFileSync(path.join(f, '.git/info/exclude'), 'utf8'), /^node_modules\/$/m);
});

test('prepareRepo on existing repo with zero commits does not add user files', () => {
  const f = tmp();
  git(f, 'init');
  fs.writeFileSync(path.join(f, 'app.js'), 'x');
  prepareRepo(f);
  assert.equal(git(f, 'ls-tree', '-r', '--name-only', 'agentherd'), '');
});

test('merge succeeds although _main is dirty (modified + untracked files)', () => {
  const f = tmp();
  prepareRepo(f);
  const w0 = taskWorktree(f, 0);
  fs.writeFileSync(path.join(w0, 'a.txt'), 'a\n');
  commitAll(w0, 'a');
  assert.equal(mergeTask(f, 0, 'a').ok, true);
  const main = mainWorktreePath(f);
  fs.writeFileSync(path.join(main, 'a.txt'), 'scribbled\n');
  fs.writeFileSync(path.join(main, 'y.txt'), 'stray\n');
  const w1 = taskWorktree(f, 1);
  fs.writeFileSync(path.join(w1, 'y.txt'), 'real\n');
  fs.writeFileSync(path.join(w1, 'a.txt'), 'changed\n');
  commitAll(w1, 'y');
  assert.equal(mergeTask(f, 1, 'y').ok, true);
  assert.equal(fs.readFileSync(path.join(main, 'y.txt'), 'utf8'), 'real\n');
  assert.equal(git(main, 'status', '--porcelain'), '');
});

test('mergeTask rethrows failures that are not conflicts', () => {
  const f = tmp();
  prepareRepo(f);
  assert.throws(() => mergeTask(f, 42, 'no such branch'));
});

test('removeTaskWorktree keepBranchAs renames the branch', () => {
  const f = tmp();
  prepareRepo(f);
  const wt = taskWorktree(f, 1);
  fs.writeFileSync(path.join(wt, 'x.txt'), 'x');
  commitAll(wt, 'x');
  removeTaskWorktree(f, 1, { keepBranchAs: 'task-1-conflict-1' });
  assert.ok(!fs.existsSync(wt));
  assert.equal(git(f, 'branch', '--list', 'task-1'), '');
  assert.notEqual(git(f, 'branch', '--list', 'task-1-conflict-1'), '');
  removeTaskWorktree(f, 2, { keepBranchAs: 'task-2' }); // never started: no dir, no branch
});

test('mergeTask makes a --no-ff merge commit titled "T<id>: <title>" and returns its sha', () => {
  const f = tmp();
  prepareRepo(f);
  const wt = taskWorktree(f, 3);
  fs.writeFileSync(path.join(wt, 'x.txt'), 'x');
  commitAll(wt, 'x');
  const before = git(f, 'rev-parse', 'agentherd');
  const r = mergeTask(f, 3, 'add x');
  assert.equal(r.commit, git(f, 'rev-parse', '--short', 'agentherd'));
  assert.equal(git(f, 'log', '-1', '--format=%s', 'agentherd'), 'T3: add x');
  assert.equal(git(f, 'rev-parse', 'agentherd^1'), before);
  assert.equal(git(f, 'rev-parse', 'agentherd^2'), git(f, 'rev-parse', 'task-3'));
});

test('conflicting merge leaves agentherd, _main and the task branch untouched; retry after resolving works', () => {
  const f = tmp();
  prepareRepo(f);
  const w0 = taskWorktree(f, 0);
  fs.writeFileSync(path.join(w0, 'y.txt'), 'base\n');
  commitAll(w0, 'y');
  mergeTask(f, 0, 'y');
  const w1 = taskWorktree(f, 1);
  const w2 = taskWorktree(f, 2);
  git(w1, 'merge', 'agentherd');
  git(w2, 'merge', 'agentherd');
  fs.writeFileSync(path.join(w1, 'y.txt'), 'one\n');
  fs.writeFileSync(path.join(w2, 'y.txt'), 'two\n');
  commitAll(w1, 'one');
  commitAll(w2, 'two');
  mergeTask(f, 1, 'one');
  const head = git(f, 'rev-parse', 'agentherd');
  const task2 = git(f, 'rev-parse', 'task-2');
  assert.equal(mergeTask(f, 2, 'two').conflict, true);
  assert.equal(git(f, 'rev-parse', 'agentherd'), head);
  assert.equal(git(f, 'rev-parse', 'task-2'), task2);
  const main = mainWorktreePath(f);
  assert.equal(git(main, 'status', '--porcelain'), '');
  assert.equal(fs.readFileSync(path.join(main, 'y.txt'), 'utf8'), 'one\n');
  try { git(w2, 'merge', 'agentherd'); } catch { /* conflict expected */ }
  fs.writeFileSync(path.join(w2, 'y.txt'), 'resolved\n');
  commitAll(w2, 'resolve');
  assert.equal(mergeTask(f, 2, 'two').ok, true);
  assert.equal(fs.readFileSync(path.join(main, 'y.txt'), 'utf8'), 'resolved\n');
});

test('cleanup after merge keeps merged content, even if the worktree is dirty', () => {
  const f = tmp();
  prepareRepo(f);
  const wt = taskWorktree(f, 1);
  fs.writeFileSync(path.join(wt, 'x.txt'), 'x');
  commitAll(wt, 'x');
  mergeTask(f, 1, 'x');
  fs.writeFileSync(path.join(wt, 'junk.txt'), 'uncommitted');
  removeTaskWorktree(f, 1);
  assert.ok(!fs.existsSync(wt));
  assert.equal(git(f, 'branch', '--list', 'task-1'), '');
  assert.equal(git(f, 'show', 'agentherd:x.txt'), 'x');
  assert.ok(!git(f, 'worktree', 'list').includes('T1'));
});

test('removeTaskWorktree keepBranchAs same name keeps the branch', () => {
  const f = tmp();
  prepareRepo(f);
  const wt = taskWorktree(f, 1);
  fs.writeFileSync(path.join(wt, 'x.txt'), 'x');
  commitAll(wt, 'x');
  removeTaskWorktree(f, 1, { keepBranchAs: 'task-1' });
  assert.ok(!fs.existsSync(wt));
  assert.notEqual(git(f, 'branch', '--list', 'task-1'), '');
});

test('commitsAhead counts task commits over agentherd', () => {
  const f = tmp();
  prepareRepo(f);
  const wt = taskWorktree(f, 1);
  assert.equal(commitsAhead(wt), 0);
  fs.writeFileSync(path.join(wt, 'x.txt'), 'x');
  commitAll(wt, 'x');
  assert.equal(commitsAhead(wt), 1);
});
