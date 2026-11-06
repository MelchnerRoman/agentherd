import * as gitModule from './git.js';
import { ROLES } from './roles.js';
import { runAgent } from './runner.js';
import { addTask, saveState, log } from './store.js';

const WORKERS = Object.values(ROLES).filter((r) => r.kind === 'worker').map((r) => r.id);
const OPEN = ['backlog', 'in_progress', 'review'];
const DIFF_CAP = 100_000;
const LIMIT_WAIT = 15 * 60_000;

const fmtTask = (t) => `Task T${t.id}: ${t.title}\n${t.description}`;
const list = (items) => (items.length ? items.map((s) => `- ${s}`).join('\n') : '(none)');

export function createOrchestrator(state, { run = runAgent, onChange = () => {}, now = Date.now, git = gitModule } = {}) {
  state.leadIdle ??= false;
  const running = new Map();

  const emit = (agent, text) => { log(state, agent, text); saveState(state); onChange(); };
  const name = (role) => ROLES[role].name;
  const free = (role) => running.size < state.maxAgents && !running.has(role);
  const addNew = (tasks = [], createdBy) => {
    for (const { title, description, role } of tasks) addTask(state, { title, description, role, createdBy });
    return tasks.length;
  };

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
      const h = run({ role: ROLES[role], prompt, cwd, onActivity: (a) => emit(name(role), a) });
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
            state.resumeAt = now() + LIMIT_WAIT;
            emit(name(role), 'hit the usage limit; pausing for 15 min');
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
      addNew(newTasks, 'reviewer');
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
      addNew(res.output.newTasks, role);
      if (res.output.status !== 'done') return failTask(role, task, res.output.summary, 'backlog');
      git.commitAll(cwd, `T${task.id}: ${task.title}`);
      task.status = 'review';
      emit(name(role), `finished T${task.id}, ready for review`);
    }, (msg) => failTask(role, task, msg, 'backlog'));
  }

  function startLead() {
    const backlog = state.tasks.filter((t) => t.status === 'backlog');
    const researchOpen = state.tasks.some((t) => t.role === 'researcher' && OPEN.includes(t.status));
    if (!free('lead') || state.leadIdle || backlog.length >= 3 || researchOpen) return;
    const unread = state.messages.filter((m) => !m.read);
    const blocked = state.tasks.filter((t) => t.status === 'blocked');
    start('lead', null, 'planning', () => ({
      cwd: git.mainWorktreePath(state.folder),
      prompt: [
        `Goal: ${state.goal}`,
        `New messages from the product owner:\n${list(unread.map((m) => m.text))}`,
        `Done tasks:\n${list(state.tasks.filter((t) => t.status === 'done').map((t) => `T${t.id}: ${t.title}`))}`,
        `Backlog:\n${list(backlog.map((t) => `T${t.id}: ${t.title}`))}`,
        `Blocked tasks (drop or replace them via dropTaskIds/newTasks):\n${list(blocked.map((t) => `T${t.id}: ${t.title} (notes: ${t.notes.join(' | ')})`))}`,
        'Plan the next tasks.',
      ].join('\n\n'),
    }), (res) => {
      if (!res.ok) return failLead(res.error);
      const { summary, newTasks, dropTaskIds = [] } = res.output;
      for (const m of unread) m.read = true;
      state.tasks = state.tasks.filter((t) => !(t.status === 'blocked' && dropTaskIds.includes(t.id)));
      if (addNew(newTasks, 'lead') === 0) state.leadIdle = true;
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
