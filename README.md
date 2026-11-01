# pi-rexagents

A [Pi](https://pi.dev) extension that runs subagents in minimized Rex panes.

Each worker is a regular interactive Pi session. Open its pane to read the conversation, steer it, send follow-up work, or interrupt it. The parent receives a completion message when the worker finishes.

Workers keep running when the parent turn is cancelled, reloaded, or closed. Reopening the parent reconnects to its workers and picks up their results.

## Installation

```sh
pi install git:git@github.com:sutekimeppou/pi-rexagents.git
```

Requires GitHub SSH access, Pi 1.4.0 or newer, and the `rex` CLI on your path. Run Pi inside a local Rex terminal session. Rex must support floating layers, minimization, and the terminal API. The extension checks the required APIs before launching a worker.

Run `/reload` to load it into an existing Pi session. Load only one copy of the extension; remove an existing local extension link before switching to the Git package.

## Agent definitions

Workers use definitions from `~/.pi/agent/agents/*.md`. If you already have a compatible `worker` definition, you can use it as-is. Otherwise, create `~/.pi/agent/agents/worker.md`:

```markdown
---
name: worker
description: Carry out a scoped implementation or review assignment.
prompt_mode: append
extensions: true
skills: true
allowed_subagents: none
---

Complete the assigned work in the specified checkout. Follow applicable project instructions, preserve unrelated changes, and report the outcome and any blockers.
```

Run `/reload` after adding or changing definitions to refresh the available-agent descriptions.

Supported frontmatter: `name`, `description`, `model`, `thinking`, `tools`, `prompt_mode: append`, boolean `extensions` and `skills`, and `allowed_subagents: none`. `tools` accepts a comma-separated string, a string array, or `none`. Omit it to use the worker's normal Pi tools. Unsupported settings produce an error when the definition is selected.

Workers load their normal Pi resources and the definition's appended instructions. Nested delegation is disabled.

## Use

Ask Pi to delegate a scoped task, for example:

> Start a worker to review the current changes. Fork this conversation so it has the context. Ask it to report findings and leave files unchanged.

The model has three tools:

| Tool | Purpose |
| --- | --- |
| `spawn_subagent` | Launch a worker or resume an existing one. |
| `get_subagent_result` | Retrieve its latest result, optionally waiting for completion. |
| `steer_subagent` | Send directions through Pi's steering queue, preserving the worker's editor draft. |

New workers require `prompt`, `description`, and `subagent_type`. Optional `name`, `model`, `thinking`, and `cwd` select their configuration. The parent's checkout, model, and thinking level provide defaults, with model and thinking overrides available in the agent definition.

Workers run in the background by default. `run_in_background: false` waits for the result. Cancelling a wait leaves the worker running.

### Fresh or forked context

`spawn_subagent` accepts `context`:

- `"fresh"` (default): start with the assignment and normal worker instructions.
- `"fork"`: copy the parent's active conversation branch at spawn time, including messages, tool history, compaction, and context edits, then add the assignment as the worker's next user message.

```json
{
  "subagent_type": "worker",
  "name": "review",
  "description": "Review the current changes",
  "prompt": "Review the current changes in the assigned checkout. Read only; report actionable findings.",
  "context": "fork"
}
```

Both modes use independent session IDs and transcripts. Forking leaves the parent unchanged. Other branches and later parent messages stay in the parent.

Set `resume` to an existing worker's name or ID to continue its conversation. Resume keeps its configuration and history; `context` only applies to new workers.

Workers share the assigned checkout. Give each assignment clear file ownership and instructions to preserve other changes. The extension does not create worktrees.

## Pane controls

Run `/agents` to select a worker and an action:

- **Open:** restore and focus its pane. A closed worker reopens its saved conversation.
- **Minimize:** keep it running in the background.
- **Stop:** interrupt the current run and keep the conversation open.
- **Close:** end the process and remove its pane after confirmation. The transcript is preserved.

Direct commands also accept a worker name or ID:

```text
/agents open review
/agents minimize review
/agents stop review
/agents close review
```

Inside a worker, use Pi normally: Enter to steer, Alt+Enter to queue follow-up work, and Escape to interrupt. Results from follow-up work are also delivered to the parent.

Native Rex pane controls remain available. If a minimized pane does not open through its Rex control, use `/agents open NAME`. Creating and minimizing a pane are separate API calls, so a brief overlay can appear during launch.

## Configuration

Optional `~/.pi/agent/rex-subagents.json`:

```json
{
  "maxOpenWorkers": 10
}
```

The default limit is 10. Idle workers count toward it because their Pi processes, extensions, and MCP connections remain alive. Close workers you have finished using.

## Storage

Assignments, launch metadata, result revisions, and Pi transcripts are stored under `$XDG_STATE_HOME/pi/rex-subagents/`, defaulting to `~/.local/state/pi/rex-subagents/`. Local control sockets use private directories under `/tmp`.

Each worker uses the same Pi installation and selected agent directory as its parent. A fork copies conversation history into the worker's transcript, and worker results are sent back to the parent.

Worker sessions keep their assigned identity. Session-switching commands such as `/new`, `/resume`, `/fork`, and `/clone` are guarded inside worker panes. Use a separate Pi session for an independent conversation.

## Development

Use Node.js 22.19 or newer:

```sh
npm install
npm run typecheck
```

Pi supplies the runtime peer dependencies. A local `npm install` also installs them so editors and TypeScript can resolve their declarations.
