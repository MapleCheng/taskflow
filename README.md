# Taskflow

An [OpenClaw](https://github.com/openclaw/openclaw) plugin for autonomous pipeline execution. Break issues into unit files, execute them sequentially via AI agent sessions, and track progress on a real-time dashboard.

## How It Works

```
Platform (deterministic runner) → OpenClaw Agent (per unit) → exec / tools
```

1. **Decompose** — Break an issue into self-contained unit files with a manifest
2. **Execute** — Platform spawns one OpenClaw agent session per unit, sequentially
3. **Track** — Real-time dashboard shows progress, logs, and session transcripts

Each unit runs as an independent agent session with full tool access (file I/O, shell, memory, web search, etc.). The platform manages state — agents just do work.

## Features

- 🔄 **Sequential pipeline execution** with nested unit support
- 📊 **Real-time dashboard** (PWA, dark theme, mobile responsive)
- 🔐 **Token-based auth** with HMAC signing and per-device binding
- 🔔 **Auto-notify** — notifies whoever triggered the pipeline, on any channel
- 🔗 **Issue tracker integration** (GitHub, GitLab, Gitea, etc.)
- 📝 **Session viewer** — inspect agent reasoning for each unit
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
          "tasksDir": "<path-to-your-tasks-directory>",
          "dashboardPort": 3847,
          "dashboardSecret": "<your-random-secret>",
          "issueBaseUrl": "<your-issue-tracker-url>"
        }
      }
    }
  }
}
```

### Config

| Key | Required | Description |
|-----|----------|-------------|
| `tasksDir` | ✅ | Path to the directory containing task folders |
| `dashboardPort` | | Dashboard port (default: `3847`) |
| `dashboardSecret` | | HMAC secret for dashboard auth. Omit for open access |
| `issueBaseUrl` | | Base URL for issue links (e.g. `https://github.com`) |
| `notify.channel` | | Fallback notification channel. Auto-detected from triggering session |
| `notify.target` | | Fallback notification target. Auto-detected from triggering session |

## Dashboard

Start the dashboard via PM2 (recommended):

```bash
pm2 start plugins/taskflow/dashboard/ecosystem.config.cjs
pm2 save
```

Generate an auth token:

```bash
node plugins/taskflow/dashboard/gen-token.cjs new    # Generate token for a new device
node plugins/taskflow/dashboard/gen-token.cjs list   # List bound devices
node plugins/taskflow/dashboard/gen-token.cjs clear  # Clear all device bindings
```

Visit `https://your-domain/?token=<generated-token>` to bind your device. After binding, the token is stored as a cookie — subsequent visits don't need the token.

## Task Structure

```
<tasksDir>/
  my-task/
    manifest.json       ← Pipeline definition + status tracking
    units/
      setup-1.md        ← Self-contained unit spec
      setup-2.md
      core-1.md
    logs/
      setup-1.log       ← Execution log per unit
```

### manifest.json

```json
{
  "issue": "org/repo#42",
  "repo": "org/repo",
  "repoPath": "/path/to/local/repo",
  "branch": "feature/issue-42",
  "status": "pending",
  "pipeline": [
    {
      "id": "setup",
      "title": "Project setup",
      "type": "config",
      "status": "pending",
      "children": [
        { "id": "setup-1", "title": "Initialize project", "status": "pending", "unit": "setup-1.md" },
        { "id": "setup-2", "title": "Create boilerplate", "status": "pending", "unit": "setup-2.md" }
      ]
    },
    {
      "id": "test-1",
      "title": "Integration tests",
      "type": "backend",
      "status": "pending",
      "unit": "test-1.md"
    }
  ]
}
```

### Unit Files

Each `.md` file is a self-contained spec with everything an agent needs:

```markdown
# Unit: Create user endpoint

## Task
Add a POST /api/users endpoint.

## Spec
- Validate input (name required, email format)
- Return 201 with created user
- Return 400 on validation error

## Acceptance Criteria
- Endpoint works as specified
- Tests pass
```

## Tools

The plugin registers three tools:

| Tool | Description |
|------|-------------|
| `taskflow_run` | Start pipeline execution for a task directory |
| `taskflow_status` | Get pipeline status and unit progress |
| `taskflow_list` | List all task directories and their status |

## Security

- Dashboard runs on a separate port (never on the gateway port)
- Auth uses HMAC-SHA256 signing with timing-safe comparison
- Each token is bound to one device (cookie-based)
- Bot user agents are blocked from triggering device binding
- Dashboard secret is stored in OpenClaw config, never in plugin source

## License

[MIT](LICENSE)
