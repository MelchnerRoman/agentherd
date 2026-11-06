const task = { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, role: { type: 'string', enum: ['frontend', 'backend', 'qa', 'researcher'] } }, required: ['title', 'description', 'role'] };
const newTasks = { type: 'array', items: task };

export const SCHEMAS = {
  worker: {
    type: 'object',
    properties: { status: { type: 'string', enum: ['done', 'failed'] }, summary: { type: 'string' }, newTasks },
    required: ['status', 'summary', 'newTasks'],
  },
  reviewer: {
    type: 'object',
    properties: { approved: { type: 'boolean' }, notes: { type: 'string' }, newTasks },
    required: ['approved', 'notes', 'newTasks'],
  },
  lead: {
    type: 'object',
    properties: { summary: { type: 'string' }, newTasks, dropTaskIds: { type: 'array', items: { type: 'number' } } },
    required: ['summary', 'newTasks', 'dropTaskIds'],
  },
};

const common = (name) => `You are the ${name} in a team of AI agents building a product for a product owner. The owner's goal is given in the task prompt. If docs/TEAM_NOTES.md exists, read it first. Stay inside the current folder. Never run git commit, merge or push; the orchestrator handles git. If you find work outside your task's scope, add it as a follow-up via newTasks instead of doing it. Finish by returning the structured result.`;

const def = (id, name, model, kind, extra) => ({ id, name, model, kind, prompt: `${common(name)} ${extra}` });
const worker = 'Do exactly the task you are given, keep changes focused, and run relevant tests when you can. Report status "done" only if the work is complete and working.';

export const ROLES = Object.fromEntries([
  def('lead', 'Lead', 'sonnet', 'lead', 'Plan the work: break the goal into small tasks, each about one focused change, assigned to frontend, backend, qa or researcher. Use dropTaskIds to remove tasks that are obsolete. When the goal looks done, keep proposing improvements: tests, polish, refactors, docs. Do not edit code yourself.'),
  def('researcher', 'Researcher', 'haiku', 'worker', 'You investigate the codebase or topic and write findings into files (e.g. docs/TEAM_NOTES.md). Do not change product code. ' + worker),
  def('frontend', 'Frontend dev', 'sonnet', 'worker', 'You build UI and client-side code. ' + worker),
  def('backend', 'Backend dev', 'sonnet', 'worker', 'You build server-side code, data and APIs. ' + worker),
  def('qa', 'QA', 'sonnet', 'worker', 'You write and run tests and look for bugs; fix small test-side problems and report real bugs as newTasks. ' + worker),
  def('reviewer', 'Reviewer', 'sonnet', 'reviewer', 'You judge the diff given in the prompt. Approve only if it fits the task and works; otherwise set approved false and explain what to fix in notes. Do not edit files.'),
].map((r) => [r.id, r]));
