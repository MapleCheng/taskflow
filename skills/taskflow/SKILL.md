---
name: taskflow
description: "Break issues into ordered unit pipelines and execute them sequentially via OpenClaw agent sessions. Trigger: decompose task, run pipeline, taskflow, execute issue."
---

# Taskflow — Issue Pipeline Runner

Break issues into self-contained unit files, execute them sequentially. Each unit runs as an independent agent session via the OpenClaw plugin runtime API.

## Architecture

```
Plugin (orchestrator) → runtime adapter (subagent) per unit → agent session
```

- **Plugin** (in-process): reads manifest, validates schema, finds pending unit, selects the already-decided runtime from manifest/config/run override, runs agent via runtime API, updates status
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
├── systemPrompt?: string  (optional pipeline-level system prompt)
├── agent?: AgentConfig    (per-pipeline override)
│   └── { id?, model?, timeout?, runtime? }
├── runtime?: { mode: "subagent", source?: string }  (explicit runtime from dev skill / pipeline authoring)
├── run?: { runtime?: { mode, source }, startedAt?, completedAt? }  (effective runtime for latest run)
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
    "systemPrompt": "",
    "agent": "main",
    "model": null,
    "timeout": 300000,
    "runtime": "subagent"
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `systemPrompt` | `""` | Global system prompt layered into extraSystemPrompt |
| `agent` | `"main"` | Agent id for unit execution |
| `model` | `null` | Model override (null = agent default) |
| `timeout` | `300000` | Timeout per unit in ms (5 min) |
| `runtime` | `"subagent"` | Default runtime mode. Resolution: taskflow_run override → manifest.runtime → manifest.agent.runtime → plugin config → subagent |

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
  systemPrompt: "This project uses .NET Core + React...",
  issues: [
    { url: "https://github.com/org/repo/issues/3", repo: "org/repo", number: 3, path: "/path/to/repo", branch: "feature/xxx" }
  ],
  units: [
    {
      id: "a",
      title: "Backend API",
      systemPrompt: "use coding skill to call coding CLI",
      children: [
        { id: "a1", title: "Business logic", type: "backend", issue: "https://...", prompt: "..." },
        { id: "a2", title: "Controller", type: "backend", issue: "https://...", prompt: "..." }
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

Each unit gets its own session via the selected runtime adapter:
- **Runtime selection**: resolved at `taskflow_run` time (see "Runtime Resolution" below)
- **Session key**: `taskflow-{pipelineId}-{unitId}`
- **Agent receives**: unit prompt with working directory
- **extraSystemPrompt layering** (all optional): plugin config `systemPrompt` + manifest root `systemPrompt` + group `systemPrompt`
- **Completion detected**: via subagent runtime backend (`waitForRun()`)
- **Logs**: unit logs include `Runtime:` and `Source:` headers for traceability

### 2.3 Status Updates

After each unit:
1. Parse result (done/failed)
2. Update manifest
3. All children done → parent marked done
4. Failed → stop pipeline, notify

### 2.4 Notification

Pipeline complete/stopped currently attempts a callback to the configured taskflow notification session target. Keep in mind this is session-style callback behavior, not a direct unit message.

## Phase 3: Report (status)

Use `taskflow_status` or `taskflow_list`.

## Tools

| Tool | Description |
|------|-------------|
| `taskflow_create` | Create pipeline with manifest and unit files |
| `taskflow_get(id)` | Get full manifest |
| `taskflow_update(id, ...)` | Patch title/systemPrompt/session, reset unit, update unit prompt |
| `taskflow_delete(id)` | Move task to trash |
| `taskflow_run(id)` | Start pipeline execution |
| `taskflow_status(id)` | Get pipeline status summary |
| `taskflow_list` | List all pipelines |

## System Prompt Layering

Taskflow supports optional `systemPrompt` at three levels:

1. Plugin config `systemPrompt`
2. Manifest root `systemPrompt`
3. Group `systemPrompt`

These are combined into `extraSystemPrompt` for the runtime adapter. `unit.prompt` stays as the concrete work order in the message body and should not be duplicated into a unit-level system prompt field.

## Runtime Resolution

Taskflow plugin does **not** decide which runtime to use. It only consumes an already-decided runtime:

1. **`taskflow_run({ id, runtime })`** — per-run override (optional)
2. **`manifest.runtime.mode`** — explicit pipeline metadata (preferred, set by dev skill / taskflow_create)
3. **`manifest.agent.runtime`** — legacy field for backward compatibility
4. **Plugin config `runtime`** — default fallback
5. **Hardcoded fallback**: `subagent`

The effective selection is recorded in `manifest.run.runtime` with both `mode` and `source` fields. Unit logs include runtime and source for debugging.

**Design principle**: Runtime decision belongs to dev skill / pipeline authoring phase, not the executor. Taskflow plugin is runtime-agnostic.

## Notes

1. **Sequential execution**: one unit at a time
2. **No child processes**: everything runs in-process via plugin runtime API
3. **Manifest is source of truth**: progress, reruns, skips all use manifest
4. **Fully autonomous**: trigger once, get notified on completion or failure
5. **Panic stop**: use `taskflow_stop` to halt a running pipeline and best-effort cancel the active unit
