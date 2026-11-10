# agentHerd

agentHerd runs a self-planning team of six Claude Code agents (lead, researcher, frontend, backend, QA, reviewer) on the folder you are in. You give it a goal, the lead breaks it into tasks, the others pick them up in their own git worktrees, and the reviewer checks the results. Finished work is merged into a separate `agentherd` branch. One background daemon runs per folder, and you watch it in the terminal or in a web dashboard.

## Requirements

- Node 22 or newer
- [Claude Code CLI](https://claude.com/claude-code) installed and logged in or configured for a provider (see [Providers](#providers)). By default agentHerd does not unset `ANTHROPIC_API_KEY`, so if that variable is set in your shell, runs are billed to that key instead.
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

From the shell: `agentherd stop` stops the team, `agentherd web` opens the dashboard (port 4321, or the next free one up to 4340; it only answers requests addressed to `localhost` or `127.0.0.1`), `agentherd help` shows usage. If the dashboard loses its connection it retries for about 13 seconds before showing "Team stopped", and reloads by itself when the team comes back.

## Getting the work

The team works on a branch called `agentherd`, created from your current commit. It never pushes and never touches your branch or your checkout. The team only sees committed code, so commit your changes before starting it. To take the result:

```sh
git merge agentherd
```

## Quota tips

- Use `/agents 2` (or 1) to spend your subscription more slowly.
- When a usage limit is hit, the team pauses, puts the task back, and resumes at the reset time the CLI reports (otherwise after about 15 minutes).
- If another provider is configured, `/provider <name>` switches to it without restarting the team.

## Providers

Every agent run is the installed `claude` CLI, so agentHerd can use anything Claude Code can: your subscription login, an Anthropic API key, Amazon Bedrock, Google Vertex, or an Anthropic-compatible endpoint (z.ai GLM, Kimi, DeepSeek, OpenRouter, ...).

A provider profile is a named set of environment variables plus optional model overrides, defined in `.agentherd/providers.json` (local, git-ignored):

```json
{
  "profiles": {
    "anthropic": { "label": "Anthropic API key", "env": { "ANTHROPIC_API_KEY": "sk-ant-..." } },
    "glm": {
      "label": "Z.ai GLM",
      "env": { "ANTHROPIC_BASE_URL": "https://api.z.ai/api/anthropic", "ANTHROPIC_AUTH_TOKEN": "..." },
      "models": { "default": "glm-4.6", "researcher": "glm-4.5-air" }
    },
    "bedrock-eu": {
      "label": "Bedrock (EU)",
      "env": { "CLAUDE_CODE_USE_BEDROCK": "1", "AWS_REGION": "eu-central-1" }
    }
  }
}
```

Built-in profiles: `claude` (current login/env, the default), `subscription` (ignore `ANTHROPIC_API_KEY` and use the login), `anthropic` (needs `ANTHROPIC_API_KEY` in the daemon's environment), `bedrock`, `vertex`, `kimi`, `moonshot` and `openrouter`. A profile replaces the daemon's provider-related variables, so switching back and forth cannot mix credentials; `claude` is the exception and inherits the daemon environment unchanged.

### Kimi and OpenRouter

Both speak the Anthropic Messages protocol, so Claude Code connects to them directly:

| Profile | Endpoint | Auth variable | Default model |
| --- | --- | --- | --- |
| `kimi` | Kimi Code subscription, `https://api.kimi.ai/coding/` | `KIMI_API_KEY` | `k3` |
| `moonshot` | Moonshot API, `https://api.moonshot.ai/anthropic` | `MOONSHOT_API_KEY` | `kimi-k3[1m]` |
| `openrouter` | OpenRouter, `https://openrouter.ai/api` | `OPENROUTER_API_KEY` | `anthropic/claude-sonnet-4.6` |

Export the key before starting agentHerd, then switch:

```sh
export KIMI_API_KEY="..."          # or OPENROUTER_API_KEY
agentherd stop && agentherd
```

Then `/provider kimi` or `/provider openrouter` (or use the dashboard menu). Profiles are read at startup, so restart after adding one. If you prefer to keep the key in `.agentherd/providers.json`, override the final auth variable instead of adding a new one:

```json
{
  "profiles": {
    "kimi": { "env": { "ANTHROPIC_API_KEY": "..." } },
    "openrouter": { "env": { "ANTHROPIC_AUTH_TOKEN": "sk-or-..." } }
  }
}
```

A file profile extends its built-in namesake: overriding the key or `models.default` keeps the endpoint and the model-tier mapping. The built-ins point Claude Code's background-summary, haiku and sub-agent tiers at the provider's model, because those tiers otherwise request Claude model names the endpoint does not know. To change models, override `models.default` or a role key:

```json
{
  "profiles": {
    "kimi": { "models": { "default": "k3.1-pro" } },
    "openrouter": { "models": { "default": "anthropic/claude-opus-4.6" } }
  }
}
```

OpenRouter's Claude Code compatibility is only guaranteed for Anthropic first-party models; for Kimi, use the direct `kimi` or `moonshot` profile rather than routing Kimi through OpenRouter. If a switch seems not to take effect, check `~/.claude/settings.json`: values in its `env` block override the environment agentHerd passes to `claude`.

Kimi Code authenticates with `ANTHROPIC_API_KEY`, which Claude Code may want to approve once in an interactive session; agentHerd runs headless, so if Kimi requests fail with 401 while you are signed in to Claude, use the `moonshot` profile with a Moonshot platform key (bearer auth, which takes precedence), or start `claude` once with the Kimi variables and approve the key. OpenRouter and Moonshot use `ANTHROPIC_AUTH_TOKEN`, which takes precedence over a saved Claude login.

To switch between two Claude subscriptions, log the second account into its own config directory once (`CLAUDE_CONFIG_DIR=~/.claude-work claude /login`) and add a profile such as `"work": { "label": "Claude (work account)", "env": { "CLAUDE_CONFIG_DIR": "${HOME}/.claude-work" } }`.

Switch with `/provider <name>` in the terminal view or the Provider menu in the dashboard. It takes effect on the next agent run and needs no restart. Profiles are read when the team starts, so run `agentherd stop && agentherd` after editing `providers.json` (the task board survives). Values may use `${VAR}` to read the daemon's environment — export it before `agentherd` starts, or put the value directly in `providers.json`. `models.default` is passed as `--model` for every role, and a role key such as `"researcher"` overrides just that role. A profile is validated when you switch, so a missing `${VAR}` is reported immediately instead of failing a task.

## Where state lives

In `.agentherd/` inside your project (state, daemon info, agent worktrees). It is added to `.git/info/exclude`, so git ignores it.

## Reset

```sh
agentherd stop
rm -rf .agentherd
git worktree prune
git branch -D agentherd
```

Leftover task branches (`task-1`, `task-2`, ...) are not removed by `agentherd stop`, but you don't need to delete them by hand: a run whose `.agentherd/worktrees/_main` is missing (as after the reset above) deletes stale `task-<number>` branches itself, so task numbers restarting at 1 don't pick up old work.
