# Team notes

Findings from the codebase research (task T1). Written by the Researcher; no product code was changed.

## What it is

agentHerd is a local CLI that runs a team of six Claude agents (Lead, Researcher, Frontend dev, Backend dev, QA, Reviewer) on the folder you run it in. The Lead plans tasks, workers do them in their own git worktrees, the Reviewer approves or sends back. Results land on a separate `agentherd` branch. One background daemon per folder; the user watches it in a terminal TUI or a web dashboard.

## Stack

- **Language:** plain JavaScript, ES modules (`"type": "module"` in `package.json`). No TypeScript, no build step.
- **Runtime:** Node 22 or newer (`engines.node >=22`). Node 22.23.3 is installed here.
- **Dependencies:** none. `package.json` has no `dependencies` or `devDependencies`. Only Node built-ins (`node:http`, `node:child_process`, `node:readline/promises`, `node:fs`, `node:path`) are used.
- **External tools:** the `claude` CLI (Claude Code, at `/opt/homebrew/bin/claude` on this machine), logged into a subscription, and `git`.
- **Frontend:** a single static `web/index.html` (~255 lines) served by the daemon. It listens to server-sent events for live state; on a dropped connection it re-probes `/api/state` with backoff (~13 s) before showing "Team stopped", and reloads when the daemon returns.
- **Package bin:** `agentherd` -> `bin/agentherd.js`. Installed with `npm link` from the repo.

## Structure

```
bin/agentherd.js      CLI entry: start/attach, `stop`, `web`, `help`; first-run goal prompt
src/daemon.js         background HTTP server on 127.0.0.1 (port 4321, falls back up to 4340)
                      routes: GET /, GET /api/state, GET /api/events (SSE),
                      POST /api/message, POST /api/control
                      Host must be localhost/127.0.0.1:<port> (else 403); POSTs must be
                      application/json (415), body <= 64 KB (413), a JSON object (400);
                      control: action pause|resume|stop, maxAgents integer 1..6
src/client.js         used by CLI: ensureDaemon (spawns daemon), readDaemon, api helper
src/orchestrator.js   the scheduler: starts/stops role runs, task state transitions,
                      retry (2 attempts), usage-limit pause (15 min), concurrency cap
src/runner.js         spawns `claude -p` per role with stream-json output and a JSON schema;
                      per-role read-only or read/write tool allowlists; parses stream lines
src/roles.js          six role definitions (id, name, model, kind, system prompt) and output schemas
src/git.js            repo prep, per-task worktrees under .agentherd/worktrees, commits,
                      merge of task branches into `agentherd`, cleanup; on a fresh start
                      (no .agentherd/worktrees/main) deletes stale task-<n> branches
src/store.js          state in .agentherd/state.json (atomic write via tmp + rename),
                      task model, activity log (capped at 200 entries)
src/tui.js            terminal live view and slash commands
web/index.html        web dashboard
test/*.test.js        node:test suites: daemon, daemon-post, dashboard-state, git, orchestrator, runner, store, tui
test/fake-claude      shell-style fake `claude` used by tests (not a test file; excluded from discovery)
docs/superpowers/     original design spec and implementation plan (2026-11-06)
```

### Key facts for changes

- Role models: Lead uses `sonnet`, Researcher uses `haiku`, all other roles use `sonnet`.
- Lead and Reviewer are read-only (`Read`, `Glob`, `Grep`, git log/diff/status). Workers can also `Edit`, `Write`, and run `npm`, `npx`, `node`, `ls`.
- Agents run with `--permission-mode dontAsk`, so anything not on the allowlist is denied rather than prompted.
- A task that fails twice becomes `blocked`. A usage-limit error pauses the team for 15 minutes.
- Task statuses: `backlog`, `in_progress`, `review`, `done`, `blocked`.
- The team only sees committed code. It works on a branch `agentherd` created from HEAD and never pushes.
- Runtime state lives in `.agentherd/` in the target project, added to `.git/info/exclude`.

## How to run

Requirements: Node 22+, `git`, Claude Code CLI installed and logged in.

```sh
# install the CLI once (from the repo root)
npm link

# use it in any project
cd your-project
agentherd            # first run asks for a goal; then opens the live view
agentherd web        # open the dashboard in a browser
agentherd stop       # stop the team
agentherd help
```

Empty goal in a folder with existing code sets the goal to "Understand this codebase and improve it" and creates the first Researcher task: write `docs/TEAM_NOTES.md` (this file).

## How to test

```sh
npm test             # runs `node --test` (Node's built-in test runner, no install needed)
```

- `node --test` discovers `*.test.js` files under `test/` and does not run `fake-claude`.
- The tests use `test/fake-claude` through the runner in place of the real `claude` CLI. `FAKE_MODE` env values drive its behaviour: `hang` (never finishes), `limit` (usage-limit error), default (success with `status: done`).
- At T22, `npm test` passes: 83 tests, 0 failures.

## Observations

- No lint or format tooling is configured. There is no `npm run lint`.
- No CI config is in the repo.
- `.gitignore` covers `.superpowers/` and `node_modules/`. `.agentherd/` is excluded at runtime through `.git/info/exclude`, not in `.gitignore`.
- The README was re-checked against the source in T22 (reset, POST hardening, dashboard reconnect) and matches.
