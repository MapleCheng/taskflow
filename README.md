# Taskflow

An [OpenClaw](https://github.com/openclaw/openclaw) plugin for autonomous pipeline execution. Break issues into unit files, execute them sequentially via AI agent sessions, and track progress on a real-time dashboard.

## How It Works

```
Plugin (orchestrator) → runtime adapter per unit (subagent) → agent session with tools
```

1. **Decompose** — Break an issue into self-contained unit files with a manifest
2. **Execute** — Plugin runs one agent session per unit via the OpenClaw runtime API
3. **Track** — Real-time dashboard shows progress, logs, and session transcripts

Each unit runs as an independent agent session. The plugin manages state — agents just do work.

## Features

- 🔄 **Sequential pipeline execution** with nested unit support
- 📊 **Real-time dashboard** (PWA, dark theme, mobile responsive)
- 🔐 **Token-based auth** with HMAC signing and per-device binding
- 🔔 **Auto-notify** via system events to the triggering session
- 🔗 **Multi-repo support** — each unit can target a different repo
- 📝 **Session viewer** — inspect agent reasoning for each unit
- 🤖 **Runtime adapter** — subagent execution
- 🛑 **Panic stop** — stop one/all pipelines, best-effort cancel the active unit, and prevent pending units from continuing
- ⚡ **Fully autonomous** — trigger once, get notified on completion or failure

## Installation

Copy the plugin to your OpenClaw plugins directory:

```bash
cp -r taskflow ~/.openclaw/plugins/
```

Add to your `openclaw.json`:

```json
{
  "plugins": {
    "load": {
      "paths": ["~/.openclaw/plugins/taskflow"]
    },
    "entries": {
      "taskflow": {
        "enabled": true,
        "config": {
          "tasksDir": "~/clawd/tasks",
          "dashboardPort": 3847,
          "dashboardSecret": "<your-random-secret>",
          "agent": "main",
          "model": null,
          "timeout": 300000,
          "runtime": "subagent"
        }
      }
    }
  }
}
```

### Config

| Key | Required | Default | Description |
|-----|----------|---------|-------------|
| `tasksDir` | ✅ | `~/clawd/tasks` | Directory containing task folders |
| `dashboardPort` | | `3847` | Dashboard port |
| `dashboardSecret` | | | HMAC secret for dashboard auth |
| `agent` | | `"main"` | Agent id for unit execution. Set to a custom agent for tool isolation |
| `model` | | `null` | Model override for unit sessions (null = agent default) |
| `timeout` | | `300000` | Timeout per unit in ms (5 min) |
| `runtime` | | `"subagent"` | Default runtime mode. Taskflow currently supports `subagent` only |

## Dashboard

Start the dashboard via PM2 (recommended):

```bash
pm2 start plugins/taskflow/dashboard/ecosystem.config.cjs
pm2 save
```

Generate an auth token:

```bash
node plugins/taskflow/dashboard/gen-token.cjs new
```

Visit `https://your-domain/?token=<token>` to bind your device.

## Schema

### Manifest v2

```
Manifest
├── id: string             (YYMMDDHHmmss, = folder name)
├── title: string
├── session: string        (notification target, e.g. "discord:channel:123")
├── status: PipelineStatus
├── createdAt, startedAt?, completedAt?
├── issues?: Issue[]
│   └── { url, repo, number, path, branch? }
├── systemPrompt?: string  (optional pipeline-level system prompt)
├── agent?: AgentConfig
│   └── { id?, model?, timeout?, runtime? }
├── runtime?: { mode: "subagent", source?: "manifest.runtime" | ... }
├── run?: { runtime?: { mode, source }, startedAt?, completedAt? }
├── stopRequestedAt?, stopReason?
├── pipeline leaf status may become cancelled after panic stop
└── pipeline: Group[]
    └── Group
        ├── id, title, status, systemPrompt?
        └── children: Unit[]
            └── Unit
                ├── id, title, type?, status
                ├── unit? (filename), issue?
                ├── children?: Unit[]  (recursive nesting)
                └── startedAt?, completedAt?, note?, error?
```

### Unit Files

Each `.md` file in `units/` is a self-contained prompt:

```markdown
# Unit: Create user endpoint

## Task
Add a POST /api/users endpoint.

## Spec
- Validate input (name required, email format)
- Return 201 with created user

## Acceptance Criteria
- Endpoint works as specified
- Tests pass
```

## Tools

| Tool | Description |
|------|-------------|
| `taskflow_create` | Create a new pipeline with manifest and unit files |
| `taskflow_run` | Start pipeline execution |
| `taskflow_status` | Get pipeline status and unit progress |
| `taskflow_stop` | Stop a running pipeline and best-effort cancel the active unit |
| `taskflow_stop_all` | Global panic stop for all running pipelines |
| `taskflow_list` | List all task directories and their status |
| `taskflow_update` | Patch manifest fields, prompts, runtime, and optional systemPrompt layers |

## Architecture

```
Plugin (index.ts)
├── taskflow_create  → generates manifest + unit files
├── taskflow_run     → resolves effective runtime and invokes adapter per unit
├── taskflow_stop    → panic stop + best-effort cancel current unit runtime
├── taskflow_stop_all→ global panic stop for all running pipelines
├── taskflow_status  → reads manifest
└── taskflow_list    → scans tasks dir

Platform (src/platform.js)
├── runPipeline()    → sequential executor loop
├── findNextPending()→ tree traversal
├── validateManifest()→ schema validation
└── executeUnit()    → delegates to injected executor

Runtime adapters (src/runtime.js)
├── subagent adapter → runtime.subagent.run()/waitForRun()/getSessionMessages()
├── subagent adapter → runtime.subagent.run()/waitForRun()/getSessionMessages()
└── stopUnit()       → best-effort cancel/stop for active runtime

Types (src/types.ts)
└── Manifest, Group, Unit, Issue, AgentConfig, RuntimeSelection, UnitExecutor
```

No child processes. No CLI shelling. Everything runs in-process via the OpenClaw plugin runtime API.

## System Prompt Layering

Taskflow supports optional `systemPrompt` at three levels:

1. **Plugin config `systemPrompt`** — global default rules for every unit
2. **Manifest root `systemPrompt`** — pipeline-wide rules
3. **Group `systemPrompt`** — extra rules for a specific group such as `backend` or `verify`

These are all optional. They are combined into `extraSystemPrompt` for the runtime adapter in this order:

```text
plugin config.systemPrompt
+ manifest.systemPrompt
+ group.systemPrompt
```

`unit.prompt` remains the actual work order and is kept in the normal message body, alongside working directory.

## Runtime Resolution

Taskflow currently supports `subagent` only.

If `manifest.runtime.mode`, `manifest.agent.runtime`, or `taskflow_run({ runtime })` are present, they should still resolve to `subagent`. The effective selection is recorded in `manifest.run.runtime` for observability.

## Panic Stop Semantics

`taskflow_stop(id, reason?)` is the operator-facing emergency brake:

- Marks `manifest.status = "stopped"`
- Persists `stopRequestedAt` + `stopReason`
- Best-effort cancels the active runtime session/run
- Converts the active `running` unit and all remaining `pending` units to `cancelled`
- Prevents any later unit from starting

`taskflow_stop_all(reason?)` applies the same behavior to every currently running pipeline.

### Runtime-specific stop behavior

- **subagent**: tries `cancelRun` / `stopRun` / `abortRun` / `killRun`, then session-level stop methods
- **future compatible runtimes**: any backend exposing `cancel*` / `stop*` / `abort*` / `terminate*` / `close*` can participate

### Why this is different from restarting the gateway

Gateway restart is a blunt kill switch: it tears down the whole OpenClaw process and can interrupt unrelated work.
Taskflow panic stop is scoped: it records intent in the manifest, attempts to stop only the affected runtime session, leaves the gateway alive, and preserves enough state for later inspection / rerun.

### Dashboard / backend note

The dashboard can expose a **Stop Pipeline** button by POSTing to `/taskflow/api/tasks/:id/stop`.
A backend/global kill switch can POST `{ "action": "stop-all" }` to `/taskflow/api/tasks`.

## License

[MIT](LICENSE)
