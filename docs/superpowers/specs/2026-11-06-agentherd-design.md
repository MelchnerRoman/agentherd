# agentHerd — design

## Intent

A local app that runs a whole software team made of Claude agents. The user is
the **product owner**: they give a starting point and watch. The team plans
its own tasks, does the work, reviews it and keeps going without being asked.
The user is a web developer, not an AI/ops person, so it has to work by
running one command and clicking in a browser.

## What the user said (decided)

- The team works **continuously** on tasks. The **tasks come from the team**,
  not from the user.
- The user is product owner. They click into a dashboard and see an
  **overview**: what each agent is working on and **how many tasks** there are.
- A project starts from one of: a **short product idea**, a **general idea /
  direction**, or an **existing codebase** that the team must **research and
  understand first**.
- Runs on the user's **Claude subscription** (not an API key). Use the **most
  efficient** way.
- Runs **fully on its own**, no approval steps, but with **git versioning**.

## Goals

1. **CLI, used like Claude Code** (decided by the user). Install once
   (`npm install -g` from this repo), then `cd` into any folder and run
   `agentherd`. The team works on the folder you are in. One team per folder.
2. First run in a folder asks for the starting text (idea, direction, or
   "understand this codebase and improve it"). An existing codebase is detected
   and the Researcher goes first.
3. **Terminal live view** (the main UI): the 6 agents with their current task,
   task counts per column, a scrolling activity feed, and a prompt at the
   bottom. Typing plain text sends a PO message to the team. Slash commands:
   `/pause`, `/resume`, `/stop`, `/tasks`, `/task <id>`, `/agents <n>`
   (concurrency cap), `/web`, `/quit`.
4. **Background:** the team always runs in a background process for that
   folder, so it keeps working after you close the terminal. `agentherd` starts
   it if it isn't running, then opens the live view. If it is running,
   `agentherd` attaches to it and never starts a second one. `/quit` only closes
   the view. `/stop` or `agentherd stop` stops the team.
5. **Both UIs** (decided by the user): `/web` (or `agentherd web`) opens the
   same overview in the browser at `http://localhost:4321`. Same data, same
   live updates, same PO message box and pause/stop buttons as the
   terminal.
6. One **orchestrator** keeps the team busy: it hands out tasks, watches them
   and moves them along, and asks for new planning when the backlog runs low.
7. The live overview (terminal and browser):
   - board columns: Backlog · In progress · Review · Done (plus a Failed/Blocked marker)
   - task counts per column
   - one card per agent showing its role, status (working / idle / paused) and current task
   - an activity feed showing what agents are doing right now (files edited,
     commands run, short summaries)
   - task detail: description, who did it, review notes, commit link/hash
8. A **product owner message box**: the user can drop in a wish or feedback at
   any time. The team picks it up at its next planning step. It is input, not
   a command queue.
9. **Start / Pause / Stop** per project. State survives a restart: stop the
   app, start it again, and it carries on.

## Team (roles)

My call, editable in one roles config file:

| Role | Does | Model (my call, for quota) |
|---|---|---|
| Lead (PM + architect) | turns the goal/PO messages into tasks, sets priorities, plans when backlog is low, handles stuck tasks | sonnet |
| Researcher | first task on an existing codebase: reads it, writes `docs/TEAM_NOTES.md` (stack, structure, how to run/test) that every later agent reads | haiku |
| Frontend dev | UI tasks | sonnet |
| Backend dev | server/data tasks | sonnet |
| QA | writes/runs tests, files bug tasks | sonnet |
| Reviewer | reviews a finished task's diff, approves or sends it back with notes | sonnet |

Agents can **create tasks** (e.g. QA files a bug, reviewer asks for a
follow-up, a dev splits work). Tasks always go to the backlog, and the Lead
can re-prioritise them.

## How it works (decided parts)

- **Agents = the installed `claude` CLI in headless mode** (`claude -p …`),
  which uses the user's subscription login. Each task is one fresh CLI run with
  a role prompt plus the task, in the project folder. No API key, no Agent SDK.
- **The orchestrator is plain code**, not an LLM, so it costs no quota. It
  calls the Lead agent only for planning.
- **All six roles are active by default** (decided by the user): up to one
  run per role at the same time, so 6 agents can work at once. A setting
  lowers the total cap (1–6) if quota runs out too fast. An agent with
  nothing to do stays idle and costs nothing.
- **Usage limit handling:** when a CLI run fails because the subscription
  limit is hit, the project switches to "Paused, limit reached", shows it on
  the dashboard and retries on its own later (at the reset time if the error
  gives one, otherwise every 15 min). The task that hit the limit goes back to
  the backlog unchanged.
- **Git:** the project folder is a git repo (`git init` if it isn't one yet).
  Each dev task works on its own branch in its own **git worktree**, so
  parallel agents don't trample each other. After the reviewer approves, the
  orchestrator merges it into a shared **`agentherd` branch** (created from
  the user's current branch at project start). New task branches start from
  `agentherd`. The user's own branch and working copy are never touched. The
  user merges `agentherd` into main themselves when they're happy (decided by
  the user). A merge conflict sends the task back to the dev with the note
  "rebase on agentherd". Every finished task leaves
  at least one commit with the task id in the message. Undo = git.
- **Structured hand-back:** every agent run ends with a small JSON result
  (`status`, `summary`, `newTasks[]`, and for the reviewer `approved` +
  `notes`), which the orchestrator parses. If it's malformed, the task is
  marked failed and returns to the backlog once. A second failure flags it
  Blocked for the Lead.
- **Live activity** comes from the CLI's streaming JSON output, pushed to the
  browser with Server-Sent Events.

## Constraints

- macOS, Node 22, `claude` CLI 2.x already installed and logged in.
- Zero or near-zero npm dependencies (Node stdlib for server, SSE, child
  processes; one plain HTML/JS/CSS page for the dashboard).
- State lives in plain JSON on disk (tasks, agents, activity log), one file
  per project, so it is easy to inspect and survives restarts.
- Agents must not touch files outside the project folder. Permission mode: the
  builder picks the narrowest setting that still lets agents edit files and
  run normal dev commands (git, npm/npx, node, test runners) without
  prompting. No approval prompts may block an unattended run.

## Non-goals

- A full-screen fancy TUI framework (keep the terminal view simple), multi-user, login, cloud hosting, deployment to production.
- Live chatting with individual agents.
- Drag-and-drop editing of the board (the team owns the board, the user watches).
- Supporting other AI providers.

## Anti-goals (failure even if it "works")

- Burning quota on busywork: endless re-planning, idle loops, or reviews
  ping-ponging. Cap: 3 review rounds per task, then it goes to the Lead as
  Blocked.
- Damaging anything outside the project folder, or losing work (anything
  unmerged stays on its branch).
- Needing terminal skills beyond running one command.
- A dashboard that looks busy but hides that nothing is progressing:
  failures and pauses must be visible.

## "Continuous" behaviour

When the backlog drops below a threshold (default 3), the orchestrator asks
the Lead to plan the next batch toward the goal, taking in new PO messages
and the done list. When the original goal looks done, the Lead keeps
proposing improvements (tests, polish, refactors, docs). The team runs until
the user pauses/stops it or the quota pauses it.

## Calls I made (Claude), after builder review

- **Pause vs Stop:** Pause = running agents finish their task, nothing new
  starts. Stop (and quitting the app) = running agents are killed, their tasks
  go back to the backlog, and their worktree/branch is kept so the next attempt
  continues from the partial work. On restart, anything left "In progress"
  is treated the same way.
- **Outside-folder safety is best effort, not a hard sandbox:** CLI
  permission allowlist + role prompt instructions. Worktrees live inside the
  project folder at `.agentherd/worktrees/` (git-ignored). A hard sandbox
  would break `npm install` and similar.
- **One agent per role** by default (6 cards, always visible, idle or
  working). Extra copies of a role (e.g. "Backend dev #2") are a later
  setting, not in the first version.
- **Never pushes to a remote.**
- Lead, Reviewer, QA and Researcher runs count toward the concurrency cap.
  QA/Researcher work that changes files goes through a worktree + review like
  dev work.

## Left to the builder

File layout, exact prompts, the JSON schema details, dashboard styling, how
the project list is stored, the exact retry/backoff numbers, how roles are
configured, and the test approach.
