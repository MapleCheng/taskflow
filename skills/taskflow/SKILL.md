---
name: taskflow
description: "Break issues into ordered unit pipelines and execute them sequentially via OpenClaw agent sessions. Trigger: decompose task, run pipeline, taskflow, execute issue."
---

# Taskflow — Issue Pipeline Runner

Break issues into self-contained unit files, execute them sequentially. Each unit runs as an independent OpenClaw agent session with full tool access.

## Architecture

```
Platform (state/flow/verify) → OpenClaw Agent (per unit, has knowledge + tools)
```

- **Platform** (deterministic Node.js): reads manifest, finds next pending unit, spawns agent, updates status
- **Agent** (OpenClaw session): executes unit spec, has memory_recall, file I/O, shell — effectively the SubAgent + Coding CLI in one

## Directory Structure

```
~/clawd/tasks/{task-dir}/
  manifest.json              ← pipeline definition + status tracking
  units/
    {id}.md                  ← self-contained unit spec
  logs/
    {id}.log                 ← execution log per unit
```

Tasks live under the **clawd workspace**, not in the target repo (avoid polluting git history).

## Phase 1: Decompose (plan)

Read Issue → break into unit pipeline → produce manifest + unit files.

### 1.1 Read Issue

```bash
# Issue tracker API (Gitea/GitHub/GitLab)
GET /repos/{owner}/{repo}/issues/{N}
GET /repos/{owner}/{repo}/issues/{N}/comments
```

### 1.2 Analyze Work Items

Parse `- [ ]` checkboxes from issue body:
- **Type**: db / backend / frontend / config / other
- **Dependencies**: execution order
- **Granularity**: one checkbox may need multiple units (nested children)

### 1.3 Produce manifest.json

```json
{
  "issue": "org/repo#21",
  "repo": "org/repo",
  "repoPath": "/path/to/repo",
  "branch": "feature/issue-21",
  "createdAt": "2026-03-07T15:46:00Z",
  "status": "pending",
  "pipeline": [
    {
      "id": "api-pending",
      "title": "Pending approval API",
      "type": "backend",
      "status": "pending",
      "children": [
        { "id": "api-pending-1", "title": "DTO definitions", "type": "backend", "status": "pending", "unit": "api-pending-1.md" },
        { "id": "api-pending-2", "title": "Business logic", "type": "backend", "status": "pending", "unit": "api-pending-2.md" },
        { "id": "api-pending-3", "title": "Controller endpoint", "type": "backend", "status": "pending", "unit": "api-pending-3.md" }
      ]
    },
    {
      "id": "frontend-1",
      "title": "Frontend component",
      "type": "frontend",
      "status": "pending",
      "unit": "frontend-1.md"
    }
  ]
}
```

### 1.4 Produce Unit Files

Each unit file is self-contained with everything needed to execute:

```markdown
# Unit: GET /approval/pending

## Task
Add a GET endpoint for pending approvals.

## Spec
- Route: GET /approval/pending
- Query params: PaginationReq
- Response: PaginationRes<PendingRes>
- Method: ApprovalBll.GetPendingList(query)

## Acceptance Criteria
- Build passes
- Endpoint returns expected response shape
```

### 1.5 Report

After decomposition, report to user:
- Number of units (including nested)
- Pipeline order
- Let user confirm or adjust

## Phase 2: Execute (run)

Use the `taskflow_run` tool to start pipeline execution.

### 2.1 Find Next Unit

Depth-first traversal of manifest:
1. Find first leaf node with `status: "pending"`
2. All preceding siblings must be `done` (sequential execution)

### 2.2 Spawn Agent

Each unit gets its own OpenClaw agent session:
- Session ID: `taskflow-{taskDir}-{unitId}`
- Agent receives unit spec as prompt
- Agent has full tool access (memory_recall, exec, read, write)

### 2.3 Update Status

After each unit:
1. Parse agent result (done/failed)
2. Update manifest: `status`, `completedAt`, `note` or `error`
3. Parent auto-done: all children done → parent marked done
4. Failed → stop pipeline, send notification

### 2.4 Notification

Pipeline complete or stopped → `openclaw message send` to configured channel.

## Phase 3: Report (status)

Use the `taskflow_status` or `taskflow_list` tools to check progress.

## Commands

| User Says | Action |
|-----------|--------|
| "Decompose issue org/repo#21" | Phase 1: decompose |
| "Run pipeline" / "Continue" | Phase 2: execute from next pending |
| "Pipeline status" | Phase 3: report progress |
| "Rerun {unit-id}" | Reset unit to pending, re-execute |
| "Skip {unit-id}" | Mark as skipped, continue |

## ⚠️ Manifest Write-back (mandatory)

After each unit completes, manifest.json MUST be updated:

1. Read `~/clawd/tasks/{dir}/manifest.json`
2. Update unit: `status` (done/failed), `completedAt`, `note`/`error`
3. Check parent: all children done → parent marked done
4. All done → top-level `status` → `done` + `completedAt`

**Not optional.** No manifest update = dashboard shows no progress = nothing happened.

## Notes

1. **Sequential execution**: one unit completes before the next starts
2. **Stub strategy**: use stubs to prevent build failures when dependencies aren't ready
3. **Accuracy over speed**: every issue goes through the pipeline
4. **Manifest is source of truth**: progress tracking, reruns, skips all use manifest
5. **Fully autonomous**: user triggers once, gets notified only on failure or completion
