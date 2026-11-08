# agentHerd

agentHerd runs a self-planning team of six Claude agents (lead, researcher, frontend, backend, QA, reviewer) on the folder you are in. You give it a goal, the lead breaks it into tasks, the others pick them up in their own git worktrees, and the reviewer checks the results. Finished work is merged into a separate `agentherd` branch. One background daemon runs per folder, and you watch it in the terminal or in a web dashboard.

## Requirements

- Node 22 or newer
- [Claude Code CLI](https://claude.com/claude-code) installed and logged in (the agents use your Claude Code login). agentHerd does not unset `ANTHROPIC_API_KEY`, so if that variable is set in your shell, runs are billed to that key instead.
- git (a folder that is not a repo gets `git init` and an initial commit of all its files)

## Install

```sh
git clone https://github.com/MelchnerRoman/agentherd.git agentHerd
cd agentHerd && npm link
```

## Usage

```sh
cd your-project
agentherd
```

The first time, it asks what the team should build (an idea, a direction, or empty to have them study the existing code and improve it). In an empty folder, an empty answer asks again, since there is no code to study. Then you see a live view: the project status, the task board, and what each agent is doing. The team keeps working in the background if you close the terminal; run `agentherd` again to re-attach.

Type a sentence at the prompt to send a wish to the team ("add dark mode"). Slash commands:

| Command | What it does |
| --- | --- |
| `/pause`, `/resume` | pause or resume the team |
| `/agents N` | allow at most N agents at once (1 to 6) |
| `/tasks` | list all tasks |
| `/task <id>` | show one task (e.g. `/task 3`) |
| `/web` | open the dashboard in your browser |
| `/stop` | stop the team and its background process |
| `/quit` | leave the view, the team keeps working |
| `/help` | list the commands |

From the shell: `agentherd stop` stops the team, `agentherd web` opens the dashboard (port 4321, or the next free one up to 4340), `agentherd help` shows usage.

## Getting the work

The team works on a branch called `agentherd`, created from your current commit. It never pushes and never touches your branch or your checkout. The team only sees committed code, so commit your changes before starting it. To take the result:

```sh
git merge agentherd
```

## Quota tips

- Use `/agents 2` (or 1) to spend your subscription more slowly.
- When a usage limit is hit, the team pauses, puts the task back, and resumes by itself after about 15 minutes.

## Where state lives

In `.agentherd/` inside your project (state, daemon info, agent worktrees). It is added to `.git/info/exclude`, so git ignores it.

## Reset

```sh
agentherd stop
rm -rf .agentherd
git worktree prune
git branch -D agentherd
git branch --list 'task-*'   # then delete each listed branch: git branch -D task-1 task-2 ...
```

The task branches (`task-1`, `task-2`, ...) are not removed by `agentherd stop`. Delete them on reset, otherwise a new run reuses the old branch for the same task number.
