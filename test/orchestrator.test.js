import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as gitModule from '../src/git.js';
import { createState, addTask } from '../src/store.js';
import { createOrchestrator } from '../src/orchestrator.js';

const flush = () => new Promise((r) => setImmediate(r));
const done = (extra = {}) => ({ ok: true, output: { status: 'done', summary: 'did it', newTasks: [], ...extra } });
const failed = { ok: true, output: { status: 'failed', summary: 'nope', newTasks: [] } };
const review = (approved, notes = 'fix it') => ({ ok: true, output: { approved, notes, newTasks: [] } });
const plan = (newTasks = [], dropTaskIds = []) => ({ ok: true, output: { summary: 'plan', newTasks, dropTaskIds } });

function setup({ tasks = [], maxAgents = 6, status = 'running', git } = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-orch-'));
  gitModule.prepareRepo(folder);
  const state = createState(folder, { goal: 'build a todo app', existingCode: false });
  state.maxAgents = maxAgents;
  state.status = status;
  for (const t of tasks) addTask(state, { title: `${t.role} work`, description: 'do it', createdBy: 'test', ...t });
  const calls = [];
  const run = ({ role, prompt, cwd }) => {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    const c = { role: role.id, prompt, cwd, killed: false };
    // a worker "doing the work" leaves a change behind unless told not to
    c.resolve = async (res, { change = true } = {}) => {
      if (change && role.kind === 'worker' && fs.existsSync(cwd)) fs.writeFileSync(path.join(cwd, `work-${calls.indexOf(c)}.txt`), 'w\n');
      resolve(res);
      await flush();
    };
    calls.push(c);
    return { promise, kill() { c.killed = true; resolve({ ok: false, error: 'killed' }); } };
  };
  const clock = { t: 1_000_000 };
  let changes = 0;
  const o = createOrchestrator(state, { run, now: () => clock.t, onChange: () => changes++, git });
  const last = (role) => calls.filter((c) => c.role === role).at(-1);
  const count = (role) => calls.filter((c) => c.role === role).length;
  return { folder, state, o, calls, clock, last, count, changes: () => changes };
}

test('assigns backlog task to its role and lead plans when backlog low', () => {
  const { state, o, last, changes } = setup({ tasks: [{ role: 'frontend' }] });
  o.tick();
  assert.deepEqual([...o.running.keys()].sort(), ['frontend', 'lead']);
  assert.equal(state.tasks[0].status, 'in_progress');
  assert.equal(state.tasks[0].branch, 'task-1');
  assert.deepEqual(state.agents.frontend, { status: 'working', taskId: 1 });
  assert.equal(last('frontend').cwd, gitModule.taskWorktree(state.folder, 1));
  assert.equal(last('lead').cwd, gitModule.mainWorktreePath(state.folder));
  assert.match(last('frontend').prompt, /build a todo app/);
  assert.ok(changes() > 0);
  assert.equal(state.leadIdle, false);
});

test('respects maxAgents', () => {
  const { o } = setup({ tasks: [{ role: 'frontend' }, { role: 'backend' }], maxAgents: 1 });
  o.tick();
  assert.equal(o.running.size, 1);
});

test('done → review → approved → done with commit', async () => {
  const { state, o, last } = setup({ tasks: [{ role: 'frontend' }] });
  o.tick();
  const w = last('frontend');
  fs.writeFileSync(path.join(w.cwd, 'f.txt'), 'hello\n');
  await w.resolve(done());
  assert.equal(state.tasks[0].status, 'review');
  assert.equal(state.tasks[0].reviewing, true);
  const r = last('reviewer');
  assert.equal(r.cwd, w.cwd);
  assert.match(r.prompt, /f\.txt/);
  await r.resolve(review(true));
  const t = state.tasks[0];
  assert.equal(t.status, 'done');
  assert.ok(t.commit);
  assert.equal(t.reviewing, false);
  assert.equal(fs.existsSync(w.cwd), false);
  assert.ok(fs.existsSync(path.join(gitModule.mainWorktreePath(state.folder), 'f.txt')));
  assert.deepEqual(state.agents.reviewer, { status: 'idle', taskId: null });
});

test('review rejected 3 times → blocked', async () => {
  const { state, o, last } = setup({ tasks: [{ role: 'frontend' }] });
  o.tick();
  for (let i = 1; i <= 3; i++) {
    const w = last('frontend');
    assert.equal(state.tasks[0].status, 'in_progress');
    if (i > 1) assert.match(w.prompt, new RegExp(`round ${i - 1}`));
    await w.resolve(done());
    await last('reviewer').resolve(review(false, `round ${i}`));
  }
  const t = state.tasks[0];
  assert.equal(t.status, 'blocked');
  assert.equal(t.reviewRounds, 3);
  assert.deepEqual(t.notes, ['round 1', 'round 2', 'round 3']);
});

const conflictGit = () => {
  const removed = [];
  const git = {
    ...gitModule,
    mergeTask: () => ({ ok: false, conflict: true }),
    removeTaskWorktree: (f, id, opts) => { removed.push(id); gitModule.removeTaskWorktree(f, id, opts); },
  };
  return { git, removed };
};

test('review approved but merge conflict → backlog with conflict note, work kept on a branch', async () => {
  const { git, removed } = conflictGit();
  const { state, o, last, folder } = setup({ tasks: [{ role: 'frontend' }], git });
  o.tick();
  fs.writeFileSync(path.join(last('frontend').cwd, 'f.txt'), 'work\n');
  await last('frontend').resolve(done());
  state.status = 'paused';
  await last('reviewer').resolve(review(true));
  const t = state.tasks[0];
  assert.equal(t.status, 'backlog');
  assert.deepEqual(t.notes, ['merge conflict: redo on top of current agentherd (previous attempt kept as branch task-1-conflict-1)']);
  const branches = execFileSync('git', ['branch', '--list', 'task-1*'], { cwd: folder, encoding: 'utf8' });
  assert.match(branches, /task-1-conflict-1/);
  assert.doesNotMatch(branches, /task-1\n/);
  assert.equal(t.commit, null);
  assert.equal(t.branch, null);
  assert.equal(t.reviewRounds, 1);
  assert.deepEqual(removed, [1]);
});

test('third merge conflict → blocked', async () => {
  const { git, removed } = conflictGit();
  const { state, o, last } = setup({ tasks: [{ role: 'frontend' }], git });
  o.tick();
  for (let i = 0; i < 3; i++) {
    assert.equal(state.tasks[0].status, 'in_progress');
    await last('frontend').resolve(done());
    await last('reviewer').resolve(review(true));
  }
  assert.equal(state.tasks[0].status, 'blocked');
  assert.equal(state.tasks[0].reviewRounds, 3);
  assert.deepEqual(removed, [1, 1, 1]);
});

test('worktree cleanup failing after a merge still marks the task done', async () => {
  const git = { ...gitModule, removeTaskWorktree: () => { throw new Error('cleanup broke'); } };
  const { state, o, last } = setup({ tasks: [{ role: 'frontend' }], git });
  o.tick();
  fs.writeFileSync(path.join(last('frontend').cwd, 'f.txt'), 'x\n');
  await last('frontend').resolve(done());
  state.status = 'paused';
  await last('reviewer').resolve(review(true));
  const t = state.tasks[0];
  assert.equal(t.status, 'done');
  assert.ok(t.commit);
  assert.equal(t.attempts, 0);
  assert.equal(state.leadIdle, false);
});

test('failed twice → blocked', async () => {
  const { state, o, last, count } = setup({ tasks: [{ role: 'backend' }] });
  o.tick();
  await last('backend').resolve(failed);
  assert.equal(count('backend'), 2);
  assert.equal(state.tasks[0].attempts, 1);
  await last('backend').resolve(failed);
  assert.equal(state.tasks[0].status, 'blocked');
  assert.equal(state.tasks[0].attempts, 2);
  assert.deepEqual(state.tasks[0].notes, ['nope', 'nope']);
  assert.equal(count('backend'), 2);
});

test('no structured output (ok:false) once → backlog, attempts 1', async () => {
  const { state, o, last } = setup({ tasks: [{ role: 'backend' }] });
  o.tick();
  state.status = 'paused';
  await last('backend').resolve({ ok: false, error: 'no structured output' });
  assert.equal(state.tasks[0].status, 'backlog');
  assert.equal(state.tasks[0].attempts, 1);
  assert.deepEqual(state.tasks[0].notes, ['no structured output']);
});

test('limit → task restored, status limited, attempts unchanged; tick after resumeAt resumes', async () => {
  const { state, o, last, count, clock } = setup({ tasks: [{ role: 'qa' }] });
  o.tick();
  await last('qa').resolve({ ok: false, limit: true });
  assert.equal(state.status, 'limited');
  assert.equal(state.resumeAt, clock.t + 15 * 60_000);
  assert.equal(state.tasks[0].status, 'backlog');
  assert.equal(state.tasks[0].attempts, 0);
  assert.deepEqual(state.tasks[0].notes, []);
  o.tick();
  assert.equal(count('qa'), 1);
  clock.t = state.resumeAt;
  o.tick();
  assert.equal(state.status, 'running');
  assert.equal(state.resumeAt, null);
  assert.equal(count('qa'), 2);
});

test('reviewer limit → task stays in review, not reviewing', async () => {
  const { state, o, last } = setup({ tasks: [{ role: 'qa' }] });
  o.tick();
  await last('qa').resolve(done());
  await last('reviewer').resolve({ ok: false, limit: true });
  assert.equal(state.status, 'limited');
  assert.equal(state.tasks[0].status, 'review');
  assert.equal(state.tasks[0].reviewing, false);
  assert.equal(state.tasks[0].reviewRounds, 0);
});

test('recover resets in_progress and keeps branch', async () => {
  const { state, o, folder } = setup({ tasks: [{ role: 'frontend' }, { role: 'qa' }] });
  o.tick();
  state.tasks[1].status = 'review';
  state.tasks[1].reviewing = true;
  const cwd = gitModule.taskWorktree(folder, 1);
  // simulate daemon restart: fresh orchestrator on the persisted state
  const calls = [];
  const o2 = createOrchestrator(state, { run: (a) => { calls.push(a); return { promise: new Promise(() => {}), kill() {} }; } });
  o2.recover();
  assert.equal(state.tasks[0].status, 'backlog');
  assert.equal(state.tasks[0].branch, 'task-1');
  assert.equal(state.tasks[1].reviewing, false);
  assert.ok(Object.values(state.agents).every((a) => a.status === 'idle' && a.taskId === null));
  assert.ok(fs.existsSync(cwd));
  o2.tick();
  assert.equal(calls.find((c) => c.role.id === 'frontend').cwd, cwd);
});

test('stopAll kills runs, recovers, and ignores the killed results', async () => {
  const { state, o, calls } = setup({ tasks: [{ role: 'frontend' }] });
  o.tick();
  o.stopAll();
  await flush();
  assert.ok(calls.every((c) => c.killed));
  assert.equal(o.running.size, 0);
  assert.equal(state.tasks[0].status, 'backlog');
  assert.equal(state.tasks[0].attempts, 0);
});

test('paused → tick starts nothing', () => {
  const { o, calls } = setup({ tasks: [{ role: 'frontend' }], status: 'paused' });
  o.tick();
  assert.equal(calls.length, 0);
  assert.equal(o.running.size, 0);
});

test('researcher task blocks lead planning until done', async () => {
  const { o, last, count } = setup({ tasks: [{ role: 'researcher' }] });
  o.tick();
  assert.deepEqual([...o.running.keys()], ['researcher']);
  await last('researcher').resolve(done());
  assert.equal(count('lead'), 0);
  await last('reviewer').resolve(review(true));
  assert.equal(count('lead'), 1);
});

test('lead returning no tasks is not re-run until a task finishes', async () => {
  const { state, o, last, count } = setup();
  o.tick();
  await last('lead').resolve(plan());
  assert.equal(state.leadIdle, true);
  o.tick();
  assert.equal(count('lead'), 1);
  addTask(state, { title: 'x', description: 'y', role: 'backend', createdBy: 'test' });
  o.tick();
  assert.equal(count('lead'), 1);
  await last('backend').resolve(done());
  await last('reviewer').resolve(review(true));
  assert.equal(state.leadIdle, false);
  assert.equal(count('lead'), 2);
});

test('lead failure is not re-run until a task finishes', async () => {
  const { state, o, last, count } = setup();
  o.tick();
  await last('lead').resolve({ ok: false, error: 'boom' });
  assert.equal(state.leadIdle, true);
  assert.equal(count('lead'), 1);
  assert.ok(state.activity.some((a) => /boom/.test(a.text)));
  addTask(state, { title: 'x', description: 'y', role: 'backend', createdBy: 'test' });
  o.tick();
  await last('backend').resolve(done());
  await last('reviewer').resolve(review(true));
  assert.equal(count('lead'), 2);
});

test('lead result: adds tasks, drops blocked ones, marks messages read', async () => {
  const { state, o, last } = setup();
  const blocked = addTask(state, { title: 'stuck', description: 'd', role: 'qa', createdBy: 'test' });
  blocked.status = 'blocked';
  blocked.notes.push('it broke');
  state.messages.push({ id: 1, text: 'make it blue', t: 1, read: false });
  o.tick();
  const p = last('lead').prompt;
  assert.match(p, /make it blue/);
  assert.match(p, /stuck/);
  assert.match(p, /it broke/);
  state.status = 'paused';
  await last('lead').resolve(plan([{ title: 'A', description: 'a', role: 'frontend' }], [blocked.id]));
  assert.deepEqual(state.tasks.map((t) => [t.title, t.createdBy, t.status]), [['A', 'lead', 'backlog']]);
  assert.equal(state.messages[0].read, true);
});

test('newTasks from a worker are added with createdBy role', async () => {
  const { state, o, last } = setup({ tasks: [{ role: 'qa' }] });
  o.tick();
  state.status = 'paused';
  await last('qa').resolve(done({ newTasks: [{ title: 'bug', description: 'b', role: 'backend' }] }));
  const t = state.tasks.find((x) => x.title === 'bug');
  assert.equal(t.createdBy, 'qa');
  assert.equal(t.role, 'backend');
});

test('reviewer failing twice → blocked', async () => {
  const { state, o, last, count } = setup({ tasks: [{ role: 'frontend' }] });
  o.tick();
  await last('frontend').resolve(done());
  await last('reviewer').resolve({ ok: false, error: 'crash' });
  const t = state.tasks[0];
  assert.equal(t.status, 'review');
  assert.equal(t.attempts, 1);
  assert.equal(count('reviewer'), 2);
  assert.equal(t.reviewing, true);
  await last('reviewer').resolve({ ok: false, error: 'crash' });
  assert.equal(t.status, 'blocked');
  assert.equal(t.attempts, 2);
  assert.equal(t.reviewing, false);
  assert.deepEqual(t.notes, ['crash', 'crash']);
});

test('mergeTask throwing counts as a reviewer failure', async () => {
  const git = { ...gitModule, mergeTask: () => { throw new Error('git exploded'); } };
  const { state, o, last } = setup({ tasks: [{ role: 'frontend' }], git });
  o.tick();
  await last('frontend').resolve(done());
  state.status = 'paused';
  await last('reviewer').resolve(review(true));
  const t = state.tasks[0];
  assert.equal(t.status, 'review');
  assert.equal(t.attempts, 1);
  assert.equal(t.reviewing, false);
  assert.match(t.notes[0], /git exploded/);
  assert.equal(o.running.has('reviewer'), false);
});

test('taskWorktree throwing on start → tick survives, task backlog with attempts 1', () => {
  const git = { ...gitModule, taskWorktree: () => { throw new Error('worktree broke'); } };
  const { state, o } = setup({ tasks: [{ role: 'frontend' }], git });
  assert.doesNotThrow(() => o.tick());
  const t = state.tasks[0];
  assert.equal(t.status, 'backlog');
  assert.equal(t.attempts, 1);
  assert.equal(o.running.has('frontend'), false);
  assert.deepEqual(state.agents.frontend, { status: 'idle', taskId: null });
  assert.ok(state.activity.some((a) => /worktree broke/.test(a.text)));
});

test('diffVsIntegration throwing on reviewer start → reviewer failure on that task', async () => {
  const git = { ...gitModule, diffVsIntegration: () => { throw new Error('diff broke'); } };
  const { state, o, last } = setup({ tasks: [{ role: 'frontend' }], git });
  o.tick();
  state.status = 'paused';
  await last('frontend').resolve(done());
  state.status = 'running';
  assert.doesNotThrow(() => o.tick());
  const t = state.tasks[0];
  assert.equal(t.status, 'review');
  assert.equal(t.attempts, 1);
  assert.equal(t.reviewing, false);
  assert.equal(o.running.has('reviewer'), false);
});

test('commitAll throwing → worker failure', async () => {
  const git = { ...gitModule, commitAll: () => { throw new Error('commit broke'); } };
  const { state, o, last } = setup({ tasks: [{ role: 'frontend' }], git });
  o.tick();
  state.status = 'paused';
  await last('frontend').resolve(done());
  const t = state.tasks[0];
  assert.equal(t.status, 'backlog');
  assert.equal(t.attempts, 1);
  assert.match(t.notes[0], /commit broke/);
});

test('blocked task clears leadIdle', async () => {
  const { state, o, last, count } = setup({ tasks: [{ role: 'backend' }] });
  state.leadIdle = true;
  state.tasks[0].attempts = 1;
  o.tick();
  assert.equal(count('lead'), 0);
  await last('backend').resolve(failed);
  assert.equal(state.tasks[0].status, 'blocked');
  assert.equal(state.leadIdle, false);
  assert.equal(count('lead'), 1);
});

test('worker done without changes → done, no review, worktree removed', async () => {
  const { state, o, last, count, folder } = setup({ tasks: [{ role: 'backend' }] });
  o.tick();
  const w = last('backend');
  state.leadIdle = true;
  state.status = 'paused';
  await w.resolve(done(), { change: false });
  const t = state.tasks[0];
  assert.equal(t.status, 'done');
  assert.equal(t.commit, null);
  assert.deepEqual(t.notes, ['no changes needed']);
  assert.equal(count('reviewer'), 0);
  assert.equal(fs.existsSync(w.cwd), false);
  assert.equal(execFileSync('git', ['branch', '--list', 'task-1'], { cwd: folder, encoding: 'utf8' }), '');
  assert.equal(state.leadIdle, false);
});

test('lead prompt lists open, done and blocked tasks', () => {
  const { state, o, last } = setup({ tasks: [{ role: 'frontend', title: 'Build login' }, { role: 'backend', title: 'Add API' }, { role: 'qa', title: 'Old thing' }, { role: 'qa', title: 'Stuck thing' }] });
  state.tasks[1].status = 'review';
  state.tasks[2].status = 'done';
  state.tasks[3].status = 'blocked';
  state.tasks[3].notes.push('kept failing');
  o.tick();
  const p = last('lead').prompt;
  assert.match(p, /T1 \[frontend\] Build login/);
  assert.match(p, /T2 \[backend\] Add API/);
  assert.match(p, /Old thing/);
  assert.match(p, /T4 \[qa\] Stuck thing.*kept failing/);
  assert.match(p, /Plan QA tasks only for features that are already done\./);
});

test('lead is idle after every successful plan', async () => {
  const { state, o, last, count } = setup();
  o.tick();
  await last('lead').resolve(plan([{ title: 'A', description: 'a', role: 'frontend' }]));
  assert.equal(state.leadIdle, true);
  o.tick();
  assert.equal(count('lead'), 1);
});

test('lead can drop backlog and blocked tasks; worktree dir goes, branch stays', async () => {
  const { state, o, last, folder } = setup();
  o.tick();
  const b = addTask(state, { title: 'retry me', description: 'd', role: 'qa', createdBy: 'test' });
  const x = addTask(state, { title: 'stuck', description: 'd', role: 'qa', createdBy: 'test' });
  x.status = 'blocked';
  const r = addTask(state, { title: 'in review', description: 'd', role: 'qa', createdBy: 'test' });
  r.status = 'review';
  const wt = gitModule.taskWorktree(folder, b.id);
  fs.writeFileSync(path.join(wt, 'half.txt'), 'h\n');
  gitModule.commitAll(wt, 'half done');
  state.status = 'paused';
  await last('lead').resolve(plan([], [b.id, x.id, r.id]));
  assert.deepEqual(state.tasks.map((t) => t.title), ['in review']);
  assert.equal(fs.existsSync(wt), false);
  assert.match(execFileSync('git', ['branch', '--list', `task-${b.id}`], { cwd: folder, encoding: 'utf8' }), new RegExp(`task-${b.id}`));
});

test('addNew skips titles matching a non-done task', async () => {
  const { state, o, last } = setup({ tasks: [{ role: 'frontend', title: 'Build Login' }, { role: 'qa', title: 'Write tests' }] });
  state.tasks[1].status = 'done';
  o.tick();
  state.status = 'paused';
  await last('lead').resolve(plan([
    { title: '  build login ', description: 'dup', role: 'frontend' },
    { title: 'Write tests', description: 'again, old one is done', role: 'qa' },
    { title: 'New', description: 'n', role: 'backend' },
    { title: 'new', description: 'dup in batch', role: 'backend' },
  ]));
  assert.deepEqual(state.tasks.map((t) => t.title), ['Build Login', 'Write tests', 'Write tests', 'New']);
});

test('real runner + fake claude: usage-limit error pauses 15 min, stays paused until then, then resumes', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-orch-'));
  gitModule.prepareRepo(folder);
  const state = createState(folder, { goal: 'g', existingCode: false });
  state.status = 'running';
  addTask(state, { title: 'qa work', description: 'do it', createdBy: 'test', role: 'qa' });
  const clock = { t: 1_000_000 };
  process.env.AGENTHERD_CLAUDE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-claude');
  process.env.FAKE_MODE = 'limit';
  const o = createOrchestrator(state, { now: () => clock.t });
  try {
    o.tick();
    for (let i = 0; i < 200 && state.status !== 'limited'; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(state.status, 'limited');
    assert.equal(state.resumeAt, clock.t + 15 * 60_000);
    assert.equal(state.tasks[0].status, 'backlog');
    assert.equal(state.tasks[0].attempts, 0);
    clock.t = state.resumeAt - 1;
    o.tick();
    assert.equal(state.status, 'limited');
    assert.equal(o.running.size, 0);
    delete process.env.FAKE_MODE; // limit lifted
    clock.t = state.resumeAt;
    o.tick();
    assert.equal(state.status, 'running');
    assert.ok(o.running.has('qa'));
  } finally { o.stopAll(); delete process.env.FAKE_MODE; }
});
