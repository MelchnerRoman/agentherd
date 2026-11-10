import * as gitModule from './git.js';
import { ROLES } from './roles.js';
import { runAgent } from './runner.js';
import { activeProvider, loadProviders } from './providers.js';
import { addTask, saveState, log } from './store.js';

const WORKERS = Object.values(ROLES).filter((r) => r.kind === 'worker').map((r) => r.id);
const OPEN = ['backlog', 'in_progress', 'review'];
const DIFF_CAP = 100_000;
const LIMIT_WAIT = 15 * 60_000;

const fmtTask = (t) => `Task T${t.id}: ${t.title}\n${t.description}`;
const list = (items) => (items.length ? items.map((s) => `- ${s}`).join('\n') : '(none)');

export function createOrchestrator(state, { run = runAgent, onChange = () => {}, now = Date.now, git = gitModule, providers = loadProviders(state.folder) } = {}) {
  state.leadIdle ??= false;
  state.provider ??= 'claude';
  state.proposals ??= [];
  const running = new Map();

  const emit = (agent, text) => { log(state, agent, text); saveState(state); onChange(); };
  const name = (role) => ROLES[role].name;
  const free = (role) => running.size < state.maxAgents && !running.has(role);
  const key = (title) => String(title).trim().toLowerCase();
  const addNew = (tasks = [], createdBy) => {
    for (const { title, description, role } of tasks) {
      if (state.tasks.some((t) => t.status !== 'done' && key(t.title) === key(title))) continue;
      addTask(state, { title, description, role, createdBy });
    }
  };
  // only the Lead creates tasks; follow-ups from the others wait in its next prompt
  const propose = (tasks = [], by) => { for (const t of tasks) state.proposals.push({ ...t, by }); };

  const idle = (role) => { state.agents[role] = { status: 'idle', taskId: null }; };
  const settle = (task, blocked, otherwise) => {
    task.status = blocked ? 'blocked' : otherwise;
    if (blocked) state.leadIdle = false;
  };
  // a crashed run, or a git error around it: counts against the task's attempts
  const failTask = (role, task, msg, otherwise) => {
    task.reviewing = false;
    task.attempts++;
    task.notes.push(msg ?? 'run failed');
    settle(task, task.attempts >= 2, otherwise);
    emit(name(role), `T${task.id} failed (${task.status}): ${task.notes.at(-1)}`);
  };
  const failLead = (msg) => {
    state.leadIdle = true; // don't respawn a failing Lead in a tight loop
    emit(name('lead'), `planning failed: ${msg}`);
  };

  // prepare() may throw (git); onFail(msg) handles both start errors and result-handling errors
  function start(role, task, text, prepare, onResult, onFail) {
    const entry = { taskId: task?.id ?? null };
    try {
      const { prompt, cwd } = prepare();
      // tool-use lines are feed-only: push them, skip the disk write (the next real event saves)
      const h = run({ role: ROLES[role], prompt, cwd, provider: activeProvider(state, providers), onActivity: (a) => { log(state, name(role), a); onChange(); } });
      entry.kill = h.kill;
      running.set(role, entry);
      state.agents[role] = { status: 'working', taskId: entry.taskId };
      emit(name(role), text);
      h.promise.then((res) => {
        if (running.get(role) !== entry) return; // stopped by stopAll; recover() already reset the task
        running.delete(role);
        idle(role);
        try {
          if (res.limit) {
            if (task) { task.status = role === 'reviewer' ? 'review' : 'backlog'; task.reviewing = false; }
            state.status = 'limited';
            state.resumeAt = res.resumeAt ?? now() + LIMIT_WAIT;
            emit(name(role), res.resumeAt
              ? `hit the usage limit; pausing until ${new Date(res.resumeAt).toLocaleTimeString()}`
              : 'hit the usage limit; pausing for 15 min');
          } else onResult(res);
        } catch (e) {
          onFail(`orchestrator error: ${e.message}`);
        }
        tick();
      });
    } catch (e) {
      if (running.get(role) === entry) running.delete(role);
      idle(role);
      onFail(`could not start: ${e.message}`);
    }
  }

  function startReviewer() {
    const task = state.tasks.find((t) => t.status === 'review' && !t.reviewing);
    if (!task || !free('reviewer')) return;
    const reject = (note, text) => {
      task.reviewRounds++;
      task.notes.push(note);
      settle(task, task.reviewRounds >= 3, 'backlog');
      emit(name('reviewer'), `${text} (${task.status}): ${note}`);
    };
    start('reviewer', task, `reviewing T${task.id}: ${task.title}`, () => {
      const cwd = git.taskWorktree(state.folder, task.id);
      let diff = git.diffVsIntegration(cwd);
      if (diff.length > DIFF_CAP) diff = diff.slice(0, DIFF_CAP) + '\n[diff truncated]';
      task.reviewing = true;
      return { cwd, prompt: `Review this change.\n\n${fmtTask(task)}\n\nDiff against agentherd:\n${diff || '(empty diff)'}` };
    }, (res) => {
      if (!res.ok) return failTask('reviewer', task, res.error, 'review');
      task.reviewing = false;
      const { approved, notes, newTasks } = res.output;
      propose(newTasks, 'reviewer');
      if (!approved) return reject(notes, `rejected T${task.id}`);
      const m = git.mergeTask(state.folder, task.id, task.title);
      if (m.ok) {
        task.status = 'done';
        task.commit = m.commit;
        state.leadIdle = false;
        emit(name('reviewer'), `approved and merged T${task.id} (${m.commit})`);
        try { git.removeTaskWorktree(state.folder, task.id); } catch {} // merged already; leftovers are harmless
        return;
      }
      // the redo starts fresh from the current agentherd; the approved attempt stays on a side branch
      const kept = `task-${task.id}-conflict-${task.reviewRounds + 1}`;
      git.removeTaskWorktree(state.folder, task.id, { keepBranchAs: kept });
      task.branch = null;
      reject(`merge conflict: redo on top of current agentherd (previous attempt kept as branch ${kept})`, `T${task.id} approved but has a merge conflict`);
    }, (msg) => failTask('reviewer', task, msg, 'review'));
  }

  function startWorker(role) {
    const task = state.tasks.find((t) => t.status === 'backlog' && t.role === role);
    if (!task) return;
    let cwd;
    start(role, task, `working on T${task.id}: ${task.title}`, () => {
      cwd = git.taskWorktree(state.folder, task.id);
      task.status = 'in_progress';
      task.branch = `task-${task.id}`;
      let prompt = `Goal: ${state.goal}\n\n${fmtTask(task)}`;
      if (task.notes.length) prompt += `\n\nFeedback from earlier attempts:\n${list(task.notes)}`;
      return { cwd, prompt };
    }, (res) => {
      if (!res.ok) return failTask(role, task, res.error, 'backlog');
      propose(res.output.newTasks, role);
      if (res.output.status !== 'done') return failTask(role, task, res.output.summary, 'backlog');
      git.commitAll(cwd, `T${task.id}: ${task.title}`);
      if (git.commitsAhead(cwd) === 0) {
        task.status = 'done';
        task.notes.push('no changes needed');
        state.leadIdle = false;
        emit(name(role), `finished T${task.id}: no changes needed`);
        try { git.removeTaskWorktree(state.folder, task.id); } catch {}
        return;
      }
      task.status = 'review';
      emit(name(role), `finished T${task.id}, ready for review`);
    }, (msg) => failTask(role, task, msg, 'backlog'));
  }

  function startLead() {
    const backlog = state.tasks.filter((t) => t.status === 'backlog');
    const researchOpen = state.tasks.some((t) => t.role === 'researcher' && OPEN.includes(t.status));
    const unread = state.messages.filter((m) => !m.read);
    // an owner message wakes the Lead right away, past the backlog and agent limits
    if (running.has('lead')) return;
    if (!unread.length && (!free('lead') || state.leadIdle || backlog.length >= 3 || researchOpen)) return;
    const proposals = state.proposals.slice();
    const of = (...st) => state.tasks.filter((t) => st.includes(t.status));
    start('lead', null, 'planning', () => ({
      cwd: git.mainWorktreePath(state.folder),
      prompt: [
        `Goal: ${state.goal}`,
        `New messages from the product owner:\n${list(unread.map((m) => m.text))}`,
        `Done tasks:\n${list(of('done').map((t) => t.title))}`,
        `Open tasks (backlog, in progress, in review; do not plan these again):\n${list(of(...OPEN).map((t) => `T${t.id} [${t.role}] ${t.title}`))}`,
        `Follow-ups proposed by the team (add only the ones that matter and are not covered yet):\n${list(proposals.map((p) => `[${p.role}] ${p.title}: ${p.description} (from ${p.by})`))}`,
        `Blocked tasks (drop or replace them via dropTaskIds/newTasks):\n${list(of('blocked').map((t) => `T${t.id} [${t.role}] ${t.title} (notes: ${t.notes.join(' | ')})`))}`,
        'Plan QA tasks only for features that are already done.',
        'Plan the next tasks. Use dropTaskIds to remove backlog or blocked tasks that are obsolete.',
      ].join('\n\n'),
    }), (res) => {
      if (!res.ok) return failLead(res.error);
      const { summary, newTasks, dropTaskIds = [] } = res.output;
      for (const m of unread) m.read = true;
      state.proposals.splice(0, proposals.length);
      const drop = state.tasks.filter((t) => ['backlog', 'blocked'].includes(t.status) && dropTaskIds.includes(t.id));
      for (const t of drop) try { git.removeTaskWorktree(state.folder, t.id, { keepBranchAs: `task-${t.id}` }); } catch {}
      state.tasks = state.tasks.filter((t) => !drop.includes(t));
      addNew(newTasks, 'lead');
      state.leadIdle = true; // replan only after a task finishes, gets blocked, or the owner writes
      emit(name('lead'), summary || 'planned');
    }, failLead);
  }

  function tick() {
    if (state.status === 'limited' && now() >= state.resumeAt) {
      state.status = 'running';
      state.resumeAt = null;
      emit('agentHerd', 'usage limit over; resuming');
    }
    if (state.status !== 'running') return;
    startReviewer();
    for (const role of WORKERS) if (free(role)) startWorker(role);
    startLead();
  }

  function recover() {
    for (const t of state.tasks) {
      if (t.status === 'in_progress') t.status = 'backlog';
      t.reviewing = false;
    }
    for (const role of Object.keys(state.agents)) state.agents[role] = { status: 'idle', taskId: null };
    emit('agentHerd', 'recovered state');
  }

  function stopAll() {
    for (const { kill } of running.values()) kill();
    running.clear();
    recover();
  }

  return { tick, recover, stopAll, running };
}
