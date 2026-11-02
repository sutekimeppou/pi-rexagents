# pi-rexagents

Run [Pi](https://pi.dev) subagents in minimized Rex panes. Each worker has a full Pi chat you can open, steer, and interrupt. Results return to the parent automatically.

Workers keep running when the parent turn is cancelled or its session closes. Reopening the parent reconnects to them.

## Install

```sh
pi install git:github.com/sutekimeppou/pi-rexagents
```

Requires Pi 1.4.0+ and a local Rex session with the `rex` CLI on your path. Run `/reload` after installing. Remove any existing local copy before loading this package.

## Agent setup

Definitions live in `~/.pi/agent/agents/*.md`. Create `worker.md` there if you don't already have one:

```markdown
---
name: worker
description: Complete a scoped assignment.
---

Follow the assignment and applicable project instructions. Preserve unrelated changes and report the outcome and any blockers.
```

Run `/reload` after adding a definition. Optional frontmatter includes `model`, `thinking`, `tools`, and boolean `extensions` and `skills`. Workers append their definition to normal Pi instructions. Nested delegation is disabled.

## Use

Ask Pi to delegate work:

> Start a worker to review the current changes. Fork this conversation for context. Ask it to report findings and leave files unchanged.

The model can call:

- `spawn_subagent` with `prompt`, `description`, and `subagent_type`. Optional `name`, `model`, `thinking`, and `cwd` configure the worker.
- `get_subagent_result` with `agent_id` and optional `wait: true`.
- `steer_subagent` with `agent_id` and `message`. Steering preserves the worker's editor draft.

`context: "fresh"` is the default. `context: "fork"` copies the parent's active conversation branch at spawn time, including tool history and compaction. The worker continues independently. `resume` accepts a worker's name or ID and keeps its existing history and configuration.

Workers run in the background. Set `run_in_background: false` to wait for a result. Cancelling the wait leaves the worker running.

Workers share the assigned checkout. Give them clear scopes and file ownership.

Workers start through your default login shell and receive the parent Pi process's PATH. This loads your shell's login profile and makes tools from the parent's interactive shell setup available to workers.

## Panes

Run `/agents` to open, minimize, stop, or close a worker. You can also address one directly:

```text
/agents open review
/agents minimize review
/agents stop review
/agents close review
```

Stop interrupts the current run. Close ends the process and removes the pane, keeping its transcript. Open restores a closed worker's conversation.

Inside a worker, use Enter to steer, Alt+Enter to queue follow-up work, and Escape to interrupt. Follow-up results also return to the parent.

## Configuration

The default limit is 10 open workers, including idle ones. Change it in `~/.pi/agent/rex-subagents.json`:

```json
{ "maxOpenWorkers": 10 }
```

Transcripts and worker state live under `$XDG_STATE_HOME/pi/rex-subagents/`, defaulting to `~/.local/state/pi/rex-subagents/`.

## Development

```sh
npm install
npm run typecheck
```
