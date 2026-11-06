import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { prepareRepo, mainWorktreePath, taskWorktree, commitAll, diffVsIntegration, mergeTask, removeTaskWorktree } from '../src/git.js';

const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
const git = (cwd, ...args) => execFileSync('git', [...ID, ...args], { cwd, encoding: 'utf8' }).trim();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ah-'));

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
