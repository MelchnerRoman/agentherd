# agentHerd Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A global `agentherd` CLI that runs a self-planning team of six Claude CLI agents on the current folder, with a terminal live view and a matching browser dashboard.

**Architecture:** One background **daemon** process per project folder holds the state (JSON file), runs the code-only **orchestrator** loop, spawns `claude -p` runs, and serves an HTTP API with SSE. The **terminal view** (`agentherd`) and the **web page** (`/web`) are both thin clients of that API. Git work happens in worktrees under `.agentherd/worktrees/`. Approved work is merged into an `agentherd` branch checked out in `.agentherd/worktrees/_main`.

**Tech Stack:** Node 22 ESM, stdlib only (`node:http`, `node:child_process`, `node:fs`, `node:readline`, `node:test`), `git` CLI, `claude` CLI 2.x. Zero npm dependencies.

**Spec:** `docs/superpowers/specs/2026-11-06-agentherd-design.md`

## Global Constraints

- Node 22, macOS, zero npm dependencies. Tests: `node --test` (stdlib `node:test` + `node:assert`).
- Agents are `claude -p` runs on the user's subscription. No API key, no Agent SDK.
- Agent CLI flags (verified on CLI 2.1.309): `-p <prompt> --model <m> --output-format stream-json --verbose --json-schema <json> --append-system-prompt <rolePrompt> --permission-mode dontAsk --allowedTools <list>`. The final stream line has `type:"result"`, `is_error`, `structured_output`, `result`.
- Allowed tools: `Read Edit Write Glob Grep "Bash(npm *)" "Bash(npx *)" "Bash(node *)" "Bash(ls *)" "Bash(git status*)" "Bash(git diff*)" "Bash(git log*)"`. Agents never commit, merge or push: the orchestrator does git.
- Roles and models: lead=sonnet, researcher=haiku, frontend=sonnet, backend=sonnet, qa=sonnet, reviewer=sonnet.
- Default concurrency cap 6 (setting 1–6). At most one run per role at a time.
- Backlog planning threshold: 3. Review rounds cap: 3, then `blocked`. Failed-run cap: 2 attempts, then `blocked`.
- Usage limit: pause project, put task back unchanged, retry after 15 min.
- Git: integration branch `agentherd`, created from the user's current HEAD. Never touch the user's checkout. Never push. `.agentherd/` goes in `.git/info/exclude`.
- Web port 4321, or the next free port if it's busy.
- State file: `<folder>/.agentherd/state.json`. Daemon info: `<folder>/.agentherd/daemon.json` `{pid, port}`.

## Review Focus

1. **Folder is not a git repo, an empty repo with no commits, or a repo with uncommitted changes.** Expected: `git init` plus an initial commit when needed, the `agentherd` branch is created, and the user's branch and files are left unchanged. Pinned in Task 2.
2. **Running `agentherd` a second time, or a stale `daemon.json` whose pid is dead.** Expected: attach to the live daemon, or start a fresh one. Never two daemons. Pinned in Task 5.
3. **Agent crashes or returns no `structured_output`.** Expected: back to the backlog once, then `blocked`. Pinned in Task 4.
4. **Usage limit hit mid-run.** Expected: project `limited` with `resumeAt`, the task back in the backlog unchanged, `attempts` not increased. Pinned in Tasks 3 + 4.
5. **Daemon restart with tasks `in_progress`.** Expected: they return to the backlog, and the worktree/branch is kept and reused. Pinned in Task 4.

---

## File Structure

```
package.json                 bin: agentherd -> bin/agentherd.js, "type":"module", scripts.test
bin/agentherd.js             CLI entry: argv routing, first-run question, start/attach daemon
src/store.js                 state load/save + task helpers (pure-ish)
src/git.js                   repo/branch/worktree/commit/merge helpers
src/roles.js                 role definitions, prompts, JSON schemas
src/runner.js                spawn claude, parse stream-json, detect usage limit
src/orchestrator.js          scheduling + result handling (the state machine)
src/daemon.js                HTTP API + SSE + lifecycle, hosts orchestrator
src/client.js                tiny HTTP/SSE client used by the TUI and CLI
src/tui.js                   terminal live view + prompt + slash commands
web/index.html               browser dashboard (single file)
test/*.test.js               one test file per src module
README.md
```

---

### Task 1: Project scaffold + store

**Files:**
- Create: `package.json`, `src/store.js`, `test/store.test.js`, `.gitignore` (`node_modules`)

**Interfaces — Produces:**
- `loadState(folder: string): State`: reads `.agentherd/state.json`, or returns `null` if it doesn't exist.
- `createState(folder, {goal: string, existingCode: boolean}): State`: creates and saves a new state.
- `saveState(state): void`: atomic (write `state.json.tmp`, then `renameSync`).
- `addTask(state, {title, description, role, createdBy}): Task`: assigns `id = state.nextId++`, `status:'backlog'`.
- `counts(state): {backlog, in_progress, review, done, blocked}`
- `log(state, agent: string, text: string): void`: pushes `{t: Date.now(), agent, text}` to `state.activity` and keeps the last 200.
- `State = {folder, goal, existingCode, status:'running'|'paused'|'limited'|'stopped', resumeAt:number|null, maxAgents:6, nextId:1, tasks:Task[], messages:{id,text,t,read:boolean}[], activity:[], agents:{[role]:{status:'idle'|'working', taskId:number|null}}}`
- `Task = {id, title, description, role, status:'backlog'|'in_progress'|'review'|'done'|'blocked', createdBy, attempts:0, reviewRounds:0, notes:string[], branch:string|null, commit:string|null, reviewing:false}`
- `createState` seeds `agents` with all 6 roles idle. If `existingCode` is true, it also adds the researcher task `"Research the existing codebase"` (description: write `docs/TEAM_NOTES.md` covering stack, structure, and how to run/test).

- [ ] **Step 1: Write failing tests** in `test/store.test.js`, using a temp dir from `fs.mkdtempSync(os.tmpdir()+'/ah-')`:
  - `createState then loadState round-trips`: `loadState(dir).goal === 'todo app'`, and `Object.keys(s.agents).length === 6`
  - `existingCode seeds researcher task`: `s.tasks[0].role === 'researcher'`, `s.tasks[0].status === 'backlog'`
  - `addTask increments ids`: ids are `1, 2`, `s.nextId === 3`
  - `counts`: after adding 2 tasks and setting one to `done`, the result is `{backlog:1, in_progress:0, review:0, done:1, blocked:0}`
  - `log keeps last 200`: after 250 calls, `s.activity.length === 200`
  - `loadState missing returns null`
- [ ] **Step 2:** Run `node --test test/store.test.js`. Expected: FAIL (module not found).
- [ ] **Step 3:** Implement `src/store.js` and `package.json` (`"bin":{"agentherd":"bin/agentherd.js"}`, `"type":"module"`, `"scripts":{"test":"node --test"}`, `"engines":{"node":">=22"}`).
- [ ] **Step 4:** Run `node --test test/store.test.js`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: state store`.

### Task 2: Git helpers

**Files:** Create `src/git.js`, `test/git.test.js`

**Interfaces — Produces** (all sync, `execFileSync('git', args, {cwd})`; they throw on unexpected git errors):
- `prepareRepo(folder): string`: does `git init` if `.git` is missing. If HEAD has no commit, makes an empty commit `chore: agentherd initial commit` with `-c user.name=agentHerd -c user.email=agentherd@local`. Appends `.agentherd/` to `.git/info/exclude` if it isn't there. Creates branch `agentherd` from HEAD if it doesn't exist. Ensures worktree `.agentherd/worktrees/_main` on `agentherd`. Returns the `_main` path.
- `taskWorktree(folder, taskId): string`: path `.agentherd/worktrees/T<id>`. Creates branch `task-<id>` from `agentherd` plus a worktree if missing, and reuses them if present.
- `commitAll(dir, message): string|null`: runs `git add -A`. If anything is staged, it commits (same `-c` identity) and returns the short hash, otherwise `null`.
- `diffVsIntegration(dir): string`: output of `git diff agentherd...HEAD`.
- `mergeTask(folder, taskId, title): {ok: true, commit} | {ok: false, conflict: true}`: in `_main`, runs `git merge --no-ff task-<id> -m "T<id>: <title>"`. On failure it runs `git merge --abort` and returns the conflict result.
- `removeTaskWorktree(folder, taskId): void`: `git worktree remove --force` plus `git branch -D task-<id>`.

- [ ] **Step 1: Write failing tests** (temp dirs):
  - `prepareRepo on plain folder`: creates `.git`, `git branch --list agentherd` is non-empty, and `.git/info/exclude` contains `.agentherd/`
  - `prepareRepo leaves user's branch and dirty files alone`: in a repo on branch `main` with a committed `a.txt`, plus an uncommitted change to `a.txt`, then call `prepareRepo`. `git rev-parse --abbrev-ref HEAD` is still `main`, and `a.txt` content is unchanged.
  - `prepareRepo is idempotent`: calling it twice doesn't throw
  - `task flow`: `taskWorktree(f,1)` → write `x.txt` → `commitAll` returns a hash → `diffVsIntegration` contains `x.txt` → `mergeTask` gives `{ok:true}` → `_main/x.txt` exists
  - `commitAll with no changes returns null`
  - `merge conflict`: tasks 1 and 2 both edit the same line of `y.txt` (y.txt is committed to agentherd via a task 0 merge first). Merging 1 gives ok, merging 2 gives `{ok:false, conflict:true}`, and `_main` has no `MERGE_HEAD`.
- [ ] **Step 2:** Run `node --test test/git.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement `src/git.js`.
- [ ] **Step 4:** Run the test. Expected: PASS.
- [ ] **Step 5:** Commit `feat: git worktree helpers`.

### Task 3: Roles + runner

**Files:** Create `src/roles.js`, `src/runner.js`, `test/runner.test.js`

**Interfaces — Produces:**
- `ROLES: {[id]: {id, name, model, prompt: string, kind: 'lead'|'worker'|'reviewer'}}` with ids `lead, researcher, frontend, backend, qa, reviewer` and names `Lead, Researcher, Frontend dev, Backend dev, QA, Reviewer`.
- `SCHEMAS = {worker, reviewer, lead}` (JSON Schema objects):
  - worker: `{status: enum['done','failed'], summary: string, newTasks: array}`
  - reviewer: `{approved: boolean, notes: string, newTasks: array}`
  - lead: `{summary: string, newTasks: array, dropTaskIds: number[]}`
  - `newTasks` items are always `{title, description, role: enum[frontend, backend, qa, researcher]}`.
- Role prompts (the builder writes the wording) must say: you are <name> in a team; the product owner's goal is in the task prompt; read `docs/TEAM_NOTES.md` if it exists; stay inside the current folder; do not run git commit/merge/push; add follow-up tasks via `newTasks` instead of doing out-of-scope work. The Lead plans small tasks (each about one focused change). When the goal looks done, the Lead keeps proposing improvements (tests, polish, refactors, docs). The Reviewer judges the diff given in the prompt and approves only if it fits the task and works.
- `buildArgs(role, prompt): string[]`: exactly the Global Constraints flag set, with `--json-schema JSON.stringify(SCHEMAS[role.kind])`.
- `parseLine(line: string): {activity?: string, result?: object}`: for `type:'assistant'` messages with `tool_use` content, gives activity `"<tool> <input.file_path ?? input.command ?? input.pattern ?? ''>"`, truncated to 120 chars. For `type:'result'`, gives `result`. Bad JSON gives `{}`.
- `isLimitError(result): boolean`: `result.is_error && /usage limit|rate limit|limit reached|out of usage/i.test(result.result ?? '')`.
- `runAgent({role, prompt, cwd, onActivity}): {promise: Promise<{ok, output?, limit?, error?}>, kill(): void}`: spawns `claude` with `buildArgs`, splits stdout into lines, and calls `onActivity(text)`. When it's done: limit → `{ok:false, limit:true}`; `structured_output` present and not an error → `{ok:true, output}`; otherwise `{ok:false, error: <result text or stderr tail or exit code>}`. The command is `process.env.AGENTHERD_CLAUDE ?? 'claude'`, so tests can swap in a fake.

- [ ] **Step 1: Write failing tests:**
  - `buildArgs includes dontAsk and schema`: args contain `'--permission-mode','dontAsk'`, `'--model','haiku'` for researcher, and the `--json-schema` value parses to an object with `properties.status`
  - `parseLine tool_use`: `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"src/a.js"}}]}}` gives `{activity:'Edit src/a.js'}`
  - `parseLine result` and `parseLine garbage → {}`
  - `isLimitError`: `{is_error:true,result:"Claude usage limit reached"}` → true, `{is_error:false,result:"limit"}` → false
  - `runAgent with fake claude`: write `test/fake-claude.js` (it prints one assistant line and one result line with `structured_output:{status:'done',summary:'ok',newTasks:[]}`), set `AGENTHERD_CLAUDE` to it, and assert `ok:true` and that onActivity was called once. A second fake mode (env `FAKE_MODE=limit`) asserts `limit:true`.
- [ ] **Step 2:** Run `node --test test/runner.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement `src/roles.js`, `src/runner.js`, `test/fake-claude.js` (executable `#!/usr/bin/env node`).
- [ ] **Step 4:** Run the test. Expected: PASS.
- [ ] **Step 5:** Commit `feat: roles and claude runner`.

### Task 4: Orchestrator

**Files:** Create `src/orchestrator.js`, `test/orchestrator.test.js`

**Interfaces:**
- Consumes: store (Task 1), git (Task 2), `ROLES`, `runAgent` (Task 3).
- Produces: `createOrchestrator(state, {run = runAgent, onChange = () => {}, now = Date.now}) → {tick(): void, recover(): void, stopAll(): void, running: Map<role, {taskId, kill}>}`.

**Behaviour (the decisions):**
- `recover()` (daemon start): every `in_progress` task → `backlog`, every `reviewing:true` → `false`, every agent → idle. Branch/worktree are kept.
- `tick()` does nothing unless `state.status === 'running'`. If it's `limited` and `now() >= resumeAt`, it switches to `running` first. A free slot means `running.size < state.maxAgents` and that role isn't running. In one tick, in this order:
  1. **Reviewer:** the first task with `status:'review' && !reviewing`. Prompt = task title + description + `diffVsIntegration(worktree)`. cwd = task worktree.
  2. **Workers:** for each idle worker role, the lowest-id `backlog` task of that role → `in_progress`, `branch='task-<id>'`, cwd = `taskWorktree`. Prompt = goal + task + `notes` (review feedback).
  3. **Lead:** if not running and the count of `backlog` tasks is below 3 (and there's no researcher task still open, so research comes before planning). Prompt = goal, unread PO messages, titles of done/backlog tasks, and blocked tasks with notes. cwd = `_main`. After it finishes, the messages are marked read.
- **Worker result:** `ok && status==='done'` → `commitAll(worktree, "T<id>: <title>")`, then status `review`. `ok && status==='failed'` or `!ok` → `attempts++`, `notes.push(summary/error)`. If `attempts >= 2` → `blocked`, else → `backlog`.
- **Reviewer result:** approved → `mergeTask`. On ok: `done`, `commit` saved, `removeTaskWorktree`. On conflict: note `"merge conflict: rebase on agentherd"` and back to `backlog`. Not approved → `reviewRounds++`, note pushed. If `reviewRounds >= 3` → `blocked`, else → `backlog`. Reviewer `!ok` → `reviewing=false` (try again next tick).
- **Lead idle guard (quota):** a Lead run that added 0 tasks sets `state.leadIdle=true`. While it's true the Lead isn't started again. It's cleared when any task finishes or a PO message arrives. Test: `lead returning no tasks is not re-run until a task finishes`.
- **Lead result:** `addTask` for each new task with `createdBy:'lead'`. `dropTaskIds` that are `blocked` are removed. Lead `!ok` gets logged and nothing else.
- **Any result `limit:true`:** the task gets back the status it had before the run, `attempts` is unchanged, and `state.status='limited'`, `resumeAt=now()+15*60_000`.
- `newTasks` from any role go through `addTask` with `createdBy: role`.
- Every activity and state change calls `log`, then `saveState`, then `onChange()`.
- After each finished run, `tick()` runs again right away.
- `stopAll()`: kill all running processes and run `recover()`.

- [ ] **Step 1: Write failing tests** with a fake `run` that returns a controllable deferred per call, and a real temp git repo from `prepareRepo`:
  - `assigns backlog task to its role and lead plans when backlog low`: 1 frontend task → after `tick`, running has `frontend` and `lead`
  - `respects maxAgents`: maxAgents=1 → after tick, `running.size === 1`
  - `done → review → approved → done with commit`: the fake worker writes a file in cwd and resolves done, the fake reviewer resolves approved, and the final task has `status 'done'` and a non-null `commit`
  - `review rejected 3 times → blocked`
  - `review approved but merge conflict → backlog with conflict note` (this one may stub `mergeTask` via a 4th option `git` in deps, defaulting to the real module)
  - `failed twice → blocked` and `no structured output (ok:false) once → backlog, attempts 1` (Review Focus 3)
  - `limit → task restored, status limited, attempts unchanged; tick after resumeAt resumes` (Review Focus 4, via the injected `now`)
  - `recover resets in_progress and keeps branch` (Review Focus 5)
  - `paused → tick starts nothing`
  - `researcher task blocks lead planning until done`
- [ ] **Step 2:** Run `node --test test/orchestrator.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement `src/orchestrator.js`. Make the git module injectable: `deps.git ?? gitModule`.
- [ ] **Step 4:** Run the test. Expected: PASS.
- [ ] **Step 5:** Commit `feat: orchestrator state machine`.

### Task 5: Daemon (HTTP API + SSE + lifecycle) and client

**Files:** Create `src/daemon.js`, `src/client.js`, `test/daemon.test.js`

**Interfaces — Produces:**
- `src/daemon.js` runs as `node src/daemon.js <folder>`. It loads state, `prepareRepo`, `recover()`, listens on 127.0.0.1 port 4321 (on `EADDRINUSE` it tries +1, up to 4340), and writes `.agentherd/daemon.json {pid, port}`. It runs `tick()` every 5 s and after every change. On SIGTERM/SIGINT it does `stopAll()`, saves, deletes daemon.json and exits.
- Routes:
  - `GET /`: `web/index.html`
  - `GET /api/state`: the full state JSON, plus `counts`
  - `GET /api/events`: SSE that sends `data: <state JSON>\n\n` on every change (throttled to 4/s) and once on connect
  - `POST /api/message {text}`: adds a PO message (status 400 on empty text)
  - `POST /api/control {action:'pause'|'resume'|'stop', maxAgents?:1..6}`: `stop` replies 200, then exits as on SIGTERM. `maxAgents` outside 1–6 gives 400.
- `src/client.js`:
  - `readDaemon(folder): {pid, port} | null`: returns `null` if the file is missing or the pid is dead (checked with `process.kill(pid, 0)`), and deletes the stale file.
  - `ensureDaemon(folder): Promise<{port}>`: spawns detached (`spawn(process.execPath, [daemonPath, folder], {detached:true, stdio:'ignore'}).unref()`) when `readDaemon` gives null, then polls daemon.json every 100 ms for up to 5 s.
  - `api(port, method, path, body?)`: Promise of the JSON response.
  - `subscribe(port, onState): () => void`: SSE via `http.get`, with auto-reconnect every 1 s.

- [ ] **Step 1: Write failing tests** (temp folder with an existing state, `AGENTHERD_CLAUDE` = the fake, `status` set to `paused` so nothing runs):
  - `ensureDaemon starts once`: calling `ensureDaemon` twice gives the same port and one pid (Review Focus 2)
  - `stale daemon.json is replaced`: write `{pid: 999999, port: 1}`, then `ensureDaemon` returns a new live pid
  - `message + control`: POST message → `/api/state` messages length is 1. POST `{maxAgents:3}` → `maxAgents === 3`. `{maxAgents:9}` → 400.
  - `subscribe receives state`: callback fires with an object that has `tasks`
  - `stop exits and removes daemon.json` (clean up in `after`)
- [ ] **Step 2:** Run `node --test test/daemon.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement both files.
- [ ] **Step 4:** Run the test. Expected: PASS.
- [ ] **Step 5:** Commit `feat: daemon api and client`.

### Task 6: Web dashboard

**Files:** Create `web/index.html` (inline CSS + JS, no build step)

**Interfaces — Consumes:** `/api/events`, `/api/message`, `/api/control` (Task 5).

Content (spec Goal 7): a header with the goal, project status (a `limited` banner shows resumeAt), Pause/Resume/Stop buttons and an agents-at-once selector (1–6). Six agent cards (name, working/idle, current task title). A board with 4 columns plus a blocked row, with counts in the column headers. Clicking a card opens details: description, role, notes, commit. An activity feed showing the newest 50. A PO message box (textarea + Send, Cmd+Enter sends). It uses `EventSource('/api/events')` and re-renders on each message. Text gets escaped (use `textContent`, never `innerHTML` with agent text). Use the frontend-design skill for the look.

- [ ] **Step 1:** Build the page.
- [ ] **Step 2:** Verify: start a daemon on a temp folder with seeded tasks (via `node src/daemon.js <tmp>` with state paused), open `http://localhost:<port>`, and check that cards, counts, sending a message and pausing all work. A screenshot via the browser tool counts as evidence.
- [ ] **Step 3:** Commit `feat: web dashboard`.

### Task 7: CLI entry + terminal live view

**Files:** Create `bin/agentherd.js`, `src/tui.js`, `test/tui.test.js`

**Interfaces:**
- Consumes: `loadState`, `createState` (Task 1), `ensureDaemon`, `readDaemon`, `api`, `subscribe` (Task 5).
- `renderView(state, {width, height}): string`: pure. The top line is `agentHerd · <folder basename> · <status> · agents <running>/<maxAgents>`. Then the counts line `Backlog 4 · In progress 2 · Review 1 · Done 9 · Blocked 0`. Then one line per agent (`● Frontend dev  T12 Add login form` or `○ QA  idle`). Then the activity feed fills the remaining height minus 2 lines. Lines are clipped to width, with no wrapping.
- `startTui(port, folder)`: clears the screen and draws `renderView`. Re-draws are throttled to 250 ms, and the user's typed line survives (`rl.prompt(true)`). Plain text → POST message and log `→ sent to team`. Commands: `/pause` `/resume` `/stop` `/tasks` (list grouped by status, shown until the next keypress) `/task <id>` `/agents <n>` `/web` (`open http://localhost:<port>`) `/quit` (detach) `/help`. An unknown command shows the help line.
- `bin/agentherd.js` argv:
  - no args: if `loadState(cwd)` is null, ask via readline "What should the team build? (an idea, a direction, or leave empty to have them study this code and improve it)". `existingCode` = the folder has entries other than `.git`, `.agentherd`, `.DS_Store`. Empty answer + no code → ask again. Empty answer + code → goal `"Understand this codebase and improve it"`. Then `createState`, `ensureDaemon`, `startTui`.
  - `stop`: if a daemon is running, POST stop, otherwise print `not running`.
  - `web`: `ensureDaemon`, then `open` the URL.
  - `help` / `--help`: usage text.

- [ ] **Step 1: Write failing tests** for `renderView`:
  - the header contains `paused` for a paused state
  - the counts line matches `Backlog 1 · In progress 1 · Review 0 · Done 0 · Blocked 0`
  - the working agent line contains `T2` and its title; the idle agent line contains `idle`
  - with `width: 40`, no line is longer than 40 characters
- [ ] **Step 2:** Run `node --test test/tui.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement `src/tui.js` and `bin/agentherd.js` (`#!/usr/bin/env node`, `chmod +x`).
- [ ] **Step 4:** Run `node --test`. Expected: all PASS.
- [ ] **Step 5:** Commit `feat: cli and terminal view`.

### Task 8: Real end-to-end check + README

**Files:** Create `README.md`

- [ ] **Step 1:** `npm link` in the repo, then `which agentherd` prints a path.
- [ ] **Step 2:** In a fresh temp folder, run `agentherd` with goal `"a single index.html page that shows a counter with + and - buttons"` and `/agents 2`. Wait until at least one task is `done`. Verify that `git -C <tmp> log agentherd --oneline` shows a `T<n>:` merge, and that `/web` shows the same counts. Then `/stop`, and check that `daemon.json` is gone.
- [ ] **Step 3:** Write the README: install (`npm link`), usage (`agentherd`, commands, `agentherd stop`, `agentherd web`), how to get the work (`git merge agentherd`), quota notes (`/agents`), and where state lives.
- [ ] **Step 4:** Commit `docs: readme`.
