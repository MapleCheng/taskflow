# Taskflow

An [OpenClaw](https://github.com/openclaw/openclaw) plugin for autonomous pipeline execution. Break issues into unit files, execute them sequentially via AI agent sessions, and track progress on a real-time dashboard.

## How It Works

```
Plugin (orchestrator) → subagent.run() per unit → agent session with tools
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
- 🤖 **Agent isolation** — configurable agent id for role/tool separation
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
          "timeout": 300000
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
├── agent?: AgentConfig
│   └── { id?, model?, timeout? }
└── pipeline: Group[]
    └── Group
        ├── id, title, status
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
| `taskflow_list` | List all task directories and their status |

## Architecture

```
Plugin (index.ts)
├── taskflow_create  → generates manifest + unit files
├── taskflow_run     → calls subagent.run() per unit via runtime API
├── taskflow_status  → reads manifest
└── taskflow_list    → scans tasks dir

Platform (src/platform.js)
├── runPipeline()    → sequential executor loop
├── findNextPending()→ tree traversal
├── validateManifest()→ schema validation
└── executeUnit()    → delegates to injected executor

Types (src/types.ts)
└── Manifest, Group, Unit, Issue, AgentConfig, UnitExecutor
```

No child processes. No CLI shelling. Everything runs in-process via the OpenClaw plugin runtime API.

## License

[MIT](LICENSE)
