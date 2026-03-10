---
name: taskflow
description: "Break issues into ordered unit pipelines and execute them sequentially via OpenClaw agent sessions. Trigger: decompose task, run pipeline, taskflow, execute issue."
---

# Taskflow — Issue Pipeline Runner

Break issues into self-contained unit files, execute them sequentially. Each unit runs as an independent agent session via the OpenClaw plugin runtime API.

## Architecture

```
Plugin (orchestrator) → subagent.run() per unit → agent session
```

- **Plugin** (in-process): reads manifest, validates schema, finds pending unit, runs agent via runtime API, updates status
- **Agent** (isolated session): executes unit prompt, has configurable tool access

## Schema

```
Manifest
├── id: string             (YYMMDDHHmmss, = folder name)
├── title: string
├── session: string        (notification target, e.g. "discord:channel:123")
├── status: PipelineStatus (pending | running | done | failed | stopped)
├── createdAt, startedAt?, completedAt?
├── issues?: Issue[]
│   └── { url, repo, number, path, branch? }
├── agent?: AgentConfig    (per-pipeline override)
│   └── { id?, model?, timeout? }
└── pipeline: Group[]
    └── Group { id, title, status, children: Unit[] }
        └── Unit { id, title, type?, unit?, children?: Unit[], status, ... }
```

**Rules:**
- Top-level pipeline items must be Groups (must have children)
- `unit` and `children` are mutually exclusive on Unit
- `issue` must match an entry in `issues[].url`
- `id` must be globally unique across entire pipeline

## Plugin Config

```json
{
  "taskflow": {
    "tasksDir": "~/clawd/tasks",
    "agent": "main",
    "model": null,
    "timeout": 300000
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `agent` | `"main"` | Agent id for unit execution |
| `model` | `null` | Model override (null = agent default) |
| `timeout` | `300000` | Timeout per unit in ms (5 min) |

## Directory Structure

```
~/clawd/tasks/{YYMMDDHHmmss}/
  manifest.json
  units/
    {id}.md                  ← self-contained unit prompt
  logs/
    {id}.log
```

## Phase 1: Decompose (plan)

Read Issue → break into unit pipeline → use `taskflow_create`.

### 1.1 Read Issue

```bash
GET /repos/{owner}/{repo}/issues/{N}
GET /repos/{owner}/{repo}/issues/{N}/comments
```

### 1.2 Analyze Work Items

Parse checkboxes from issue body:
- **Type**: db / backend / frontend / config
- **Dependencies**: execution order
- **Granularity**: one checkbox may need multiple units

### 1.3 Create Pipeline

```
taskflow_create({
  title: "Barcode Migration",
  session: "discord:channel:123456",
  issues: [
    { url: "https://github.com/org/repo/issues/3", repo: "org/repo", number: 3, path: "/path/to/repo", branch: "feature/xxx" }
  ],
  units: [
    {
      id: "backend",
      title: "Backend API",
      children: [
        { id: "bll", title: "Business logic", type: "backend", issue: "https://...", prompt: "..." },
        { id: "controller", title: "Controller", type: "backend", issue: "https://...", prompt: "..." }
      ]
    }
  ]
})
```

Auto-generates: id (YYMMDDHHmmss), timestamps, status fields, directory structure, unit .md files.

### 1.4 Report

After creation, report `tag` (e.g. `[260310235823] Barcode Migration`) and let user confirm before running.

## Phase 2: Execute (run)

Use `taskflow_run` to start.

### 2.1 Multi-Repo Support

Each unit's `issue` field → matched to `issues[].url` → uses `issues[].path` as working directory.

### 2.2 Agent Execution

Each unit gets its own session via `subagent.run()`:
- Session key: `taskflow-{pipelineId}-{unitId}`
- Agent receives unit prompt
- Completion detected via `waitForRun()`

### 2.3 Status Updates

After each unit:
1. Parse result (done/failed)
2. Update manifest
3. All children done → parent marked done
4. Failed → stop pipeline, notify

### 2.4 Notification

Pipeline complete/stopped → system event to `manifest.session`.

## Phase 3: Report (status)

Use `taskflow_status` or `taskflow_list`.

## Tools

| Tool | Description |
|------|-------------|
| `taskflow_create` | Create pipeline with manifest and unit files |
| `taskflow_run` | Start pipeline execution |
| `taskflow_status` | Get pipeline status |
| `taskflow_list` | List all pipelines |

## Notes

1. **Sequential execution**: one unit at a time
2. **No child processes**: everything runs in-process via plugin runtime API
3. **Manifest is source of truth**: progress, reruns, skips all use manifest
4. **Fully autonomous**: trigger once, get notified on completion or failure
