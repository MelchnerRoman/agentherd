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

  function start(role, task, prompt, cwd, onResult, text) {
    const entry = { taskId: task?.id ?? null };
    const h = run({ role: ROLES[role], prompt, cwd, onActivity: (a) => emit(name(role), a) });
    entry.kill = h.kill;
    running.set(role, entry);
    state.agents[role] = { status: 'working', taskId: entry.taskId };
    emit(name(role), text);
    h.promise.then((res) => {
      if (running.get(role) !== entry) return; // stopped by stopAll; recover() already reset the task
      running.delete(role);
      state.agents[role] = { status: 'idle', taskId: null };
      try {
        if (res.limit) {
          if (task) { task.status = role === 'reviewer' ? 'review' : 'backlog'; task.reviewing = false; }
          state.status = 'limited';
          state.resumeAt = now() + LIMIT_WAIT;
          emit(name(role), 'hit the usage limit; pausing for 15 min');
        } else onResult(res);
      } catch (e) {
        emit(name(role), `orchestrator error: ${e.message}`);
      }
      tick();
    });
  }

  function startReviewer() {
    const task = state.tasks.find((t) => t.status === 'review' && !t.reviewing);
    if (!task || !free('reviewer')) return;
    const cwd = git.taskWorktree(state.folder, task.id);
    let diff = git.diffVsIntegration(cwd);
    if (diff.length > DIFF_CAP) diff = diff.slice(0, DIFF_CAP) + '\n[diff truncated]';
    task.reviewing = true;
    const prompt = `Review this change.\n\n${fmtTask(task)}\n\nDiff against agentherd:\n${diff || '(empty diff)'}`;
    const reject = (note, text) => {
      task.reviewRounds++;
      task.notes.push(note);
      task.status = task.reviewRounds >= 3 ? 'blocked' : 'backlog';
      emit(name('reviewer'), `${text} (${task.status}): ${note}`);
    };
    start('reviewer', task, prompt, cwd, (res) => {
      task.reviewing = false;
      if (!res.ok) return emit(name('reviewer'), `review of T${task.id} failed: ${res.error}`);
      const { approved, notes, newTasks } = res.output;
      addNew(newTasks, 'reviewer');
      if (approved) {
        const m = git.mergeTask(state.folder, task.id, task.title);
        if (m.ok) {
          task.status = 'done';
          task.commit = m.commit;
          git.removeTaskWorktree(state.folder, task.id);
          state.leadIdle = false;
          emit(name('reviewer'), `approved and merged T${task.id} (${m.commit})`);
        } else {
          // start the redo fresh from the current agentherd
          git.removeTaskWorktree(state.folder, task.id);
          task.branch = null;
          reject('merge conflict: redo on top of current agentherd', `T${task.id} approved but has a merge conflict`);
        }
      } else reject(notes, `rejected T${task.id}`);
    }, `reviewing T${task.id}: ${task.title}`);
  }

  function startWorker(role) {
    const task = state.tasks.find((t) => t.status === 'backlog' && t.role === role);
    if (!task) return;
    const cwd = git.taskWorktree(state.folder, task.id);
    task.status = 'in_progress';
    task.branch = `task-${task.id}`;
    let prompt = `Goal: ${state.goal}\n\n${fmtTask(task)}`;
    if (task.notes.length) prompt += `\n\nFeedback from earlier attempts:\n${list(task.notes)}`;
    start(role, task, prompt, cwd, (res) => {
      if (res.ok) addNew(res.output.newTasks, role);
      if (res.ok && res.output.status === 'done') {
        git.commitAll(cwd, `T${task.id}: ${task.title}`);
        task.status = 'review';
        return emit(name(role), `finished T${task.id}, ready for review`);
      }
      task.attempts++;
      task.notes.push((res.ok ? res.output.summary : res.error) ?? 'run failed');
      task.status = task.attempts >= 2 ? 'blocked' : 'backlog';
      emit(name(role), `T${task.id} failed (${task.status}): ${task.notes.at(-1)}`);
    }, `working on T${task.id}: ${task.title}`);
  }

  function startLead() {
    const backlog = state.tasks.filter((t) => t.status === 'backlog');
    const researchOpen = state.tasks.some((t) => t.role === 'researcher' && OPEN.includes(t.status));
    if (!free('lead') || state.leadIdle || backlog.length >= 3 || researchOpen) return;
    const unread = state.messages.filter((m) => !m.read);
    const blocked = state.tasks.filter((t) => t.status === 'blocked');
    const prompt = [
      `Goal: ${state.goal}`,
      `New messages from the product owner:\n${list(unread.map((m) => m.text))}`,
      `Done tasks:\n${list(state.tasks.filter((t) => t.status === 'done').map((t) => `T${t.id}: ${t.title}`))}`,
      `Backlog:\n${list(backlog.map((t) => `T${t.id}: ${t.title}`))}`,
      `Blocked tasks (drop or replace them via dropTaskIds/newTasks):\n${list(blocked.map((t) => `T${t.id}: ${t.title} (notes: ${t.notes.join(' | ')})`))}`,
      'Plan the next tasks.',
    ].join('\n\n');
    start('lead', null, prompt, git.mainWorktreePath(state.folder), (res) => {
      if (!res.ok) {
        state.leadIdle = true; // don't respawn a failing Lead in a tight loop
        return emit(name('lead'), `planning failed: ${res.error}`);
      }
      const { summary, newTasks, dropTaskIds = [] } = res.output;
      for (const m of unread) m.read = true;
      state.tasks = state.tasks.filter((t) => !(t.status === 'blocked' && dropTaskIds.includes(t.id)));
      if (addNew(newTasks, 'lead') === 0) state.leadIdle = true;
      emit(name('lead'), summary || 'planned');
    }, 'planning');
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
