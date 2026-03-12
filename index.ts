/**
 * Taskflow Plugin — OpenClaw plugin for autonomous pipeline execution
 * 
 * Tools: taskflow_create, taskflow_get, taskflow_update, taskflow_delete, taskflow_run, taskflow_status, taskflow_list
 * Service: Dashboard on configurable port
 * Notification: via plugin runtime (no shell out)
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { Manifest, Group, Unit, Issue, TaskflowPluginConfig, UnitExecutor, UnitResult, RuntimeMode, RuntimeSelection, NotifyFn } from "./src/types.js";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { readdirSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { Type } from "@sinclair/typebox";
import { fileURLToPath } from "node:url";
import { buildUnitExecutor, createStopController, stopUnit, resolveRuntimeSelection, runEndOfRunReporter } from "./src/runtime.js";

// Running pipelines tracked in memory
const runningPipelines = new Map<string, {
  startedAt: string;
  stopRequested?: boolean;
  stopReason?: string;
  stopRequestedAt?: string;
  stopController?: any;
}>();

// Shared reference to plugin API
let pluginApi: OpenClawPluginApi | null = null;

async function panicStopPipeline(api: OpenClawPluginApi, tasksDir: string, taskDir: string, reason?: string) {
  const manifestPath = join(tasksDir, taskDir, "manifest.json");
  if (!existsSync(manifestPath)) return { error: `Task ${taskDir} not found` };

  const state = runningPipelines.get(taskDir);
  const stopReason = reason || "Panic stop requested";
  const manifest: Manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  manifest.stopRequestedAt = new Date().toISOString();
  manifest.stopReason = stopReason;
  if (manifest.status === "running") manifest.status = "stopped";
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  if (!state) {
    return { id: taskDir, stopped: true, running: false, message: "Pipeline marked stopped (was not actively running)" };
  }

  state.stopRequested = true;
  state.stopReason = stopReason;
  state.stopRequestedAt = manifest.stopRequestedAt || undefined;
  if (state.stopController) {
    state.stopController.requested = true;
    state.stopController.reason = stopReason;
  }

  const stopResult = state.stopController
    ? await stopUnit(api as any, state.stopController, api.logger)
    : { stopped: false, reason: "no active unit controller" };

  return {
    id: taskDir,
    stopped: true,
    running: true,
    cancelIssued: stopResult.stopped,
    cancelReason: stopResult.reason,
    errors: stopResult.errors,
  };
}

export default {
  register(api: OpenClawPluginApi) {
    pluginApi = api;
    const config = (api.pluginConfig || {}) as TaskflowPluginConfig;
    const tasksDir = api.resolvePath(config.tasksDir || join(homedir(), "clawd", "tasks"));
    const dashboardPort = config.dashboardPort || 3847;
    const __dirname = dirname(fileURLToPath(import.meta.url));

    // ── Tool: taskflow_create ──
    api.registerTool(() => ({
      name: "taskflow_create",
      label: "Create Taskflow Pipeline",
      description: "Create a new taskflow pipeline with manifest and unit files. Auto-generates id, timestamps, and status fields.",
      parameters: Type.Object({
        title: Type.String({ description: "Pipeline title (human-readable name)" }),
        systemPrompt: Type.Optional(Type.String({ description: "Optional pipeline-level system prompt layered into extraSystemPrompt" })),
        runtime: Type.Optional(Type.Object({
          mode: Type.Literal("subagent", { description: "Execution runtime mode. Default: subagent" }),
        })),
        issues: Type.Optional(Type.Array(Type.Object({
          url: Type.String({ description: "Issue URL (e.g. https://gitea.example.com/org/repo/issues/3)" }),
          repo: Type.String({ description: "Repo short name (e.g. org/repo)" }),
          number: Type.Number({ description: "Issue number" }),
          path: Type.String({ description: "Local repo path" }),
          branch: Type.Optional(Type.String({ description: "Git branch name" })),
        }), { description: "Related issues with repo info" })),
        units: Type.Array(Type.Object({
          id: Type.String({ description: "Unique unit id" }),
          title: Type.String({ description: "Unit title" }),
          systemPrompt: Type.Optional(Type.String({ description: "Optional group-level system prompt layered into extraSystemPrompt" })),
          issue: Type.Optional(Type.String({ description: "Issue URL this unit belongs to (must match issues[].url)" })),
          prompt: Type.Optional(Type.String({ description: "Unit prompt content (for leaf units)" })),
          children: Type.Optional(Type.Array(Type.Object({
            id: Type.String(),
            title: Type.String(),
            type: Type.Optional(Type.String({ description: "Unit type (e.g. backend, frontend, db, config)" })),
            issue: Type.Optional(Type.String()),
            prompt: Type.String({ description: "Unit prompt content" }),
          }))),
        }), { description: "Pipeline units (leaf with prompt, or group with children)", minItems: 1 }),
      }),
      async execute(_toolCallId: string, params: {
        title: string;
        systemPrompt?: string;
        runtime?: { mode?: RuntimeMode };
        issues?: Array<{ url: string; repo: string; number: number; path: string; branch?: string }>;
        units: Array<{
          id: string;
          title: string;
          systemPrompt?: string;
          issue?: string;
          prompt?: string;
          children?: Array<{ id: string; title: string; type?: string; issue?: string; prompt: string }>;
        }>;
      }) {
        const { title, systemPrompt, runtime, issues, units } = params as typeof params & { runtime?: { mode?: RuntimeMode } };

        // Generate unique id
        // Generate id from current timestamp: tf-YYYYMMDDHHmmss (+ suffix if collision)
        const now = new Date();
        const base = "" + String(now.getFullYear()).slice(2)
          + String(now.getMonth() + 1).padStart(2, "0")
          + String(now.getDate()).padStart(2, "0")
          + String(now.getHours()).padStart(2, "0")
          + String(now.getMinutes()).padStart(2, "0")
          + String(now.getSeconds()).padStart(2, "0");
        let id = base;
        let suffix = 1;
        while (existsSync(join(tasksDir, id))) {
          id = base + "-" + suffix++;
        }
        const taskPath = join(tasksDir, id);
        const unitsPath = join(taskPath, "units");

        // Build pipeline structure and collect unit files to write
        const unitFiles: Array<{ filename: string; content: string }> = [];
        const pipeline: Group[] = units.map(u => {
          const children: Unit[] = (u.children || []).map(c => {
            const filename = `${c.id}.md`;
            unitFiles.push({ filename, content: c.prompt });
            return {
              id: c.id,
              title: c.title,
              ...(c.type ? { type: c.type } : {}),
              ...(c.issue ? { issue: c.issue } : {}),
              unit: filename,
              status: "pending" as const,
            };
          });
          return {
            id: u.id,
            title: u.title,
            ...(u.systemPrompt ? { systemPrompt: u.systemPrompt } : {}),
            status: "pending" as const,
            children,
          };
        });

        // Build manifest
        const manifest: Manifest = {
          id,
          title,
          status: "pending",
          createdAt: new Date().toISOString(),
          startedAt: null,
          completedAt: null,
          ...(systemPrompt ? { systemPrompt } : {}),
          ...(runtime?.mode ? { runtime: { mode: runtime.mode, source: "manifest.runtime" } } : {}),
          ...(issues && issues.length > 0 ? { issues: issues as Issue[] } : {}),
          stopRequestedAt: null,
          stopReason: null,
          pipeline,
        };

        // Validate before writing
        // Dynamic import to avoid TS issues with .js
        const { validateManifest: validate } = await import("./src/platform.js");
        const validation = validate(manifest);
        if (!validation.valid) {
          return {
            error: "Manifest validation failed",
            details: validation.errors,
          };
        }

        // Create directories
        mkdirSync(unitsPath, { recursive: true });

        // Write unit files
        for (const uf of unitFiles) {
          writeFileSync(join(unitsPath, uf.filename), uf.content);
        }

        // Write manifest
        writeFileSync(join(taskPath, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

        return {
          id,
          tag: `[${id}] ${title}`,
          title,
          path: taskPath,
          unitCount: unitFiles.length,
          pipeline: pipeline.map(g => ({
            id: g.id,
            title: g.title,
            children: g.children.map(c => ({ id: c.id, title: c.title })),
          })),
          warnings: validation.warnings.length > 0 ? validation.warnings : undefined,
        };
      },
    }));

    // ── Tool: taskflow_run ──
    api.registerTool(() => ({
      name: "taskflow_run",
      label: "Run Taskflow Pipeline",
      description: "Start a taskflow pipeline for a task directory. Runs in background, sends notification on completion.",
      parameters: Type.Object({
        id: Type.String({ description: "Task id (= folder name, e.g. 260310151300)" }),
        session: Type.String({ description: "OpenClaw session id to deliver completion notification (e.g. agent:main:target:session-id)" }),
        runtime: Type.Optional(Type.Literal("subagent", { description: "Optional per-run runtime override. Default resolution: manifest.runtime → manifest.agent.runtime → plugin config → subagent" })),
      }),
      async execute(_toolCallId: string, params: { id: string; session: string; runtime?: RuntimeMode }) {
        const taskDir = params.id;
        const manifestPath = join(tasksDir, taskDir, "manifest.json");

        if (!existsSync(manifestPath)) {
          return { error: `manifest.json not found in ${tasksDir}/${taskDir}` };
        }

        if (runningPipelines.has(taskDir)) {
          return { error: `Pipeline ${taskDir} is already running` };
        }

        const stopController = createStopController();
        runningPipelines.set(taskDir, { startedAt: new Date().toISOString(), stopController });

        // Read manifest for agent config
        const manifest: Manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

        // Build executor using selected runtime adapter (default: subagent)
        const runState = runningPipelines.get(taskDir)!;
        const runtimeSelection: RuntimeSelection = resolveRuntimeSelection(config, manifest, params.runtime);
        manifest.run = {
          ...(manifest.run || {}),
          runtime: runtimeSelection,
        };
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
        const executor: UnitExecutor = buildUnitExecutor(api as any, config, manifest, {
          logger: api.logger,
          stopController: runState.stopController,
          runtimeMode: runtimeSelection.mode,
        }) as UnitExecutor;

        // Spawn reporter subagent at end of run
        const onNotify: NotifyFn = async (finalManifest: Manifest, payload: any) => {
          const targetSession = params.session;
          if (!targetSession) {
            api.logger.warn(`taskflow[${taskDir}]: reporter: no targetSession (not passed to taskflow_run), skipping`);
            return;
          }
          const runtime = (api as any).runtime?.subagent;
          if (!runtime) {
            api.logger.warn(`taskflow[${taskDir}]: reporter: subagent runtime unavailable, skipping`);
            return;
          }
          try {
            const payloadJson = JSON.stringify(payload, null, 2);
            const message = `Input payload (JSON):\n\`\`\`json\n${payloadJson}\n\`\`\`\n\nWrite a concise human-readable summary of this pipeline result, then deliver it via sessions_send to ${targetSession}.\nThe message MUST begin with exactly this line on its own: [FORWARD_TO_USER]\nFollowed by the summary content.`;
            const runStartedAt = manifest.run?.startedAt || new Date().toISOString();
            await runtime.run({
              sessionKey: `taskflow-${taskDir}-reporter`,
              message,
              idempotencyKey: `taskflow-reporter-${taskDir}-${runStartedAt}`,
            });
            api.logger.info(`taskflow[${taskDir}]: reporter spawned (target: ${targetSession})`);
          } catch (e: any) {
            api.logger.error(`taskflow[${taskDir}]: reporter spawn failed: ${e.message}`);
            // No fallback
          }
        };

        // Run pipeline in background (non-blocking)
        const { runPipeline } = await import("./src/platform.js");
        runPipeline(tasksDir, taskDir, {
          executor,
          pluginSystemPrompt: config.systemPrompt || "",
          dashboardUrl: `http://localhost:${dashboardPort}`,
          runtimeSelection,
          shouldStop: () => Boolean(runningPipelines.get(taskDir)?.stopRequested),
          onNotify,
          logger: {
            info: (msg: string) => api.logger.info(`taskflow[${taskDir}]: ${msg}`),
            warn: (msg: string) => api.logger.warn(`taskflow[${taskDir}]: ${msg}`),
            error: (msg: string) => api.logger.error(`taskflow[${taskDir}]: ${msg}`),
          },
        }).catch((e: Error) => {
          api.logger.error(`taskflow[${taskDir}]: Fatal: ${e.message}`);
        }).finally(() => {
          runningPipelines.delete(taskDir);
        });

        return {
          status: "started",
          taskDir,
          runtime: runtimeSelection.mode,
          runtimeSource: runtimeSelection.source,
          dashboard: `http://localhost:${dashboardPort}`,
        };
      },
    }));

    // ── Tool: taskflow_stop ──
    api.registerTool(() => ({
      name: "taskflow_stop",
      label: "Stop Taskflow Pipeline",
      description: "Stop a running taskflow pipeline and cancel the current unit when supported by the runtime backend.",
      parameters: Type.Object({
        id: Type.String({ description: "Task id (= folder name)" }),
        reason: Type.Optional(Type.String({ description: "Why the pipeline is being stopped" })),
      }),
      async execute(_toolCallId: string, params: { id: string; reason?: string }) {
        return await panicStopPipeline(api, tasksDir, params.id, params.reason);
      },
    }));

    // ── Tool: taskflow_stop_all ──
    api.registerTool(() => ({
      name: "taskflow_stop_all",
      label: "Stop All Taskflow Pipelines",
      description: "Stop all running taskflow pipelines and best-effort cancel their active units.",
      parameters: Type.Object({
        reason: Type.Optional(Type.String({ description: "Why all pipelines are being stopped" })),
      }),
      async execute(_toolCallId: string, params: { reason?: string }) {
        const activeIds = [...runningPipelines.keys()];
        const reason = params.reason || "Global panic stop requested";
        const results = [];
        for (const id of activeIds) {
          results.push(await panicStopPipeline(api, tasksDir, id, reason));
        }
        return {
          stopped: results.length,
          reason,
          results,
        };
      },
    }));

    // ── Tool: taskflow_status ──
    api.registerTool(() => ({
      name: "taskflow_status",
      label: "Taskflow Status",
      description: "Get the status of a taskflow pipeline, including unit progress and timing.",
      parameters: Type.Object({
        id: Type.String({ description: "Task id (= folder name)" }),
      }),
      async execute(_toolCallId: string, params: { id: string }) {
        const taskDir = params.id;
        const manifestPath = join(tasksDir, taskDir, "manifest.json");

        if (!existsSync(manifestPath)) {
          return { error: `manifest.json not found` };
        }

        try {
          const manifest: Manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
          const stats = countStats(manifest.pipeline);
          return {
            task: taskDir,
            title: manifest.title,
            status: manifest.status,
            stats,
            startedAt: manifest.startedAt,
            completedAt: manifest.completedAt,
            runtime: manifest.run?.runtime?.mode || manifest.runtime?.mode || manifest.agent?.runtime || config.runtime || "subagent",
            runtimeSource: manifest.run?.runtime?.source || manifest.runtime?.source || (manifest.agent?.runtime ? "manifest.agent.runtime" : "plugin-config"),
            stopRequestedAt: manifest.stopRequestedAt,
            stopReason: manifest.stopReason,
            running: runningPipelines.has(taskDir),
            dashboard: `http://localhost:${dashboardPort}`,
          };
        } catch (e) {
          return { error: `Failed to read manifest: ${(e as Error).message}` };
        }
      },
    }));

    // ── Tool: taskflow_get ──
    api.registerTool(() => ({
      name: "taskflow_get",
      label: "Get Taskflow Pipeline",
      description: "Get the full manifest of a taskflow pipeline, including all pipeline details and issues.",
      parameters: Type.Object({
        id: Type.String({ description: "Task id (= folder name)" }),
      }),
      async execute(_toolCallId: string, params: { id: string }) {
        const taskDir = params.id;
        const manifestPath = join(tasksDir, taskDir, "manifest.json");
        if (!existsSync(manifestPath)) {
          return { error: `Task ${taskDir} not found` };
        }
        try {
          const manifest: Manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
          return {
            ...manifest,
            running: runningPipelines.has(taskDir),
            dashboard: `http://localhost:${dashboardPort}`,
          };
        } catch (e) {
          return { error: `Failed to read manifest: ${(e as Error).message}` };
        }
      },
    }));

    // ── Tool: taskflow_update ──
    api.registerTool(() => ({
      name: "taskflow_update",
      label: "Update Taskflow Pipeline",
      description: "Update a taskflow pipeline. Can patch manifest fields (title, systemPrompt, runtime), reset unit status, or update unit/group prompt settings.",
      parameters: Type.Object({
        id: Type.String({ description: "Task id (= folder name)" }),
        title: Type.Optional(Type.String({ description: "New pipeline title" })),
        systemPrompt: Type.Optional(Type.String({ description: "New pipeline-level system prompt" })),
        runtime: Type.Optional(Type.Literal("subagent", { description: "Persist pipeline runtime selection into manifest.runtime.mode" })),
        resetUnit: Type.Optional(Type.String({ description: "Unit id to reset status to pending (for re-run)" })),
        groupId: Type.Optional(Type.String({ description: "Group id to update system prompt for" })),
        groupSystemPrompt: Type.Optional(Type.String({ description: "New group-level system prompt (requires groupId)" })),
        unitId: Type.Optional(Type.String({ description: "Unit id to update prompt for" })),
        unitPrompt: Type.Optional(Type.String({ description: "New prompt content for the unit (requires unitId)" })),
      }),
      async execute(_toolCallId: string, params: {
        id: string;
        title?: string;
        systemPrompt?: string;
        runtime?: RuntimeMode;
        resetUnit?: string;
        groupId?: string;
        groupSystemPrompt?: string;
        unitId?: string;
        unitPrompt?: string;
      }) {
        const taskDir = params.id;
        const manifestPath = join(tasksDir, taskDir, "manifest.json");
        if (!existsSync(manifestPath)) {
          return { error: `Task ${taskDir} not found` };
        }
        if (runningPipelines.has(taskDir)) {
          return { error: `Cannot update while pipeline is running` };
        }

        try {
          const manifest: Manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
          const changes: string[] = [];

          // Patch manifest fields
          if (params.title !== undefined) { manifest.title = params.title; changes.push("title"); }
          if (params.systemPrompt !== undefined) { manifest.systemPrompt = params.systemPrompt; changes.push("systemPrompt"); }
          if (params.runtime !== undefined) {
            manifest.runtime = { mode: params.runtime, source: "manifest.runtime" };
            changes.push(`runtime=${params.runtime}`);
          }

          // Reset unit status
          if (params.resetUnit) {
            const found = findUnit(manifest.pipeline, params.resetUnit);
            if (!found) return { error: `Unit ${params.resetUnit} not found` };
            found.status = "pending";
            delete (found as any).startedAt;
            delete (found as any).completedAt;
            delete (found as any).error;
            delete (found as any).note;
            // Also reset parent group if it was done/failed
            for (const g of manifest.pipeline) {
              if (g.children.some(c => c.id === params.resetUnit) || findUnit([g], params.resetUnit)) {
                if (g.status === "done" || g.status === "failed" || g.status === "cancelled" || g.status === "blocked") g.status = "pending";
              }
            }
            // Reset manifest status if it was done/failed
            if (manifest.status === "done" || manifest.status === "failed" || manifest.status === "stopped") {
              manifest.status = "pending";
              manifest.completedAt = null;
            }
            if (manifest.currentUnitId === params.resetUnit) {
              delete (manifest as any).currentUnitId;
              delete (manifest as any).currentUnitPath;
            }
            if (manifest.failedUnitId === params.resetUnit) {
              delete (manifest as any).failedUnitId;
              delete (manifest as any).failedUnitPath;
              delete (manifest as any).lastError;
            }
            changes.push(`reset unit ${params.resetUnit}`);
          }

          // Update group system prompt
          if (params.groupId && params.groupSystemPrompt !== undefined) {
            const foundGroup = manifest.pipeline.find(g => g.id === params.groupId);
            if (!foundGroup) return { error: `Group ${params.groupId} not found` };
            foundGroup.systemPrompt = params.groupSystemPrompt;
            changes.push(`updated group systemPrompt for ${params.groupId}`);
          }

          // Update unit prompt
          if (params.unitId && params.unitPrompt !== undefined) {
            const found = findUnit(manifest.pipeline, params.unitId);
            if (!found) return { error: `Unit ${params.unitId} not found` };
            if (!found.unit) return { error: `Unit ${params.unitId} has no unit file (it's a group)` };
            const unitPath = join(tasksDir, taskDir, "units", found.unit);
            writeFileSync(unitPath, params.unitPrompt);
            changes.push(`updated prompt for ${params.unitId}`);
          }

          // Write manifest
          writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

          return {
            id: taskDir,
            changes,
            status: manifest.status,
          };
        } catch (e) {
          return { error: `Failed to update: ${(e as Error).message}` };
        }
      },
    }));

    // ── Tool: taskflow_delete ──
    api.registerTool(() => ({
      name: "taskflow_delete",
      label: "Delete Taskflow Pipeline",
      description: "Delete a taskflow pipeline by moving its folder to system trash.",
      parameters: Type.Object({
        id: Type.String({ description: "Task id (= folder name)" }),
      }),
      async execute(_toolCallId: string, params: { id: string }) {
        const taskDir = params.id;
        const taskPath = join(tasksDir, taskDir);
        if (!existsSync(taskPath)) {
          return { error: `Task ${taskDir} not found` };
        }
        if (runningPipelines.has(taskDir)) {
          return { error: `Cannot delete while pipeline is running` };
        }

        try {
          // Move to trash using macOS trash command, fallback to ~/.Trash
          const { execSync } = await import("node:child_process");
          try {
            execSync(`trash "${taskPath}"`, { timeout: 5000 });
          } catch {
            // Fallback: move to ~/.Trash
            const trashPath = join(homedir(), ".Trash", taskDir);
            const { renameSync } = await import("node:fs");
            renameSync(taskPath, trashPath);
          }
          return { id: taskDir, deleted: true };
        } catch (e) {
          return { error: `Failed to delete: ${(e as Error).message}` };
        }
      },
    }));

    // ── Tool: taskflow_list ──
    api.registerTool(() => ({
      name: "taskflow_list",
      label: "List Taskflows",
      description: "List all available task directories and their status.",
      parameters: Type.Object({}),
      async execute() {
        if (!existsSync(tasksDir)) {
          return { tasks: [], tasksDir };
        }

        const dirs = readdirSync(tasksDir, { withFileTypes: true })
          .filter(d => d.isDirectory() && existsSync(join(tasksDir, d.name, "manifest.json")))
          .map(d => {
            try {
              const m: Manifest = JSON.parse(readFileSync(join(tasksDir, d.name, "manifest.json"), "utf-8"));
              const stats = countStats(m.pipeline);
              return {
                name: d.name,
                title: m.title,
                status: m.status || "pending",
                stats,
                runtime: m.run?.runtime?.mode || m.runtime?.mode || m.agent?.runtime || config.runtime || "subagent",
                running: runningPipelines.has(d.name),
              };
            } catch {
              return { name: d.name, status: "error" };
            }
          });

        return { tasks: dirs, tasksDir, dashboard: `http://localhost:${dashboardPort}` };
      },
    }));

    // ── Dashboard HTTP API (on gateway port, for internal use) ──
    api.registerHttpRoute({
      path: "/taskflow/api/tasks",
      auth: "gateway",
      handler: async (req, res) => {
        const method = String(req.method || "GET").toUpperCase();
        if (method === "POST") {
          let body = "";
          req.on("data", chunk => { body += String(chunk || ""); });
          req.on("end", async () => {
            try {
              const parsed = body ? JSON.parse(body) : {};
              if (parsed?.action === "stop-all") {
                const result = await Promise.all([...runningPipelines.keys()].map(id => panicStopPipeline(api, tasksDir, id, parsed.reason || "Dashboard panic stop")));
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ stopped: result.length, results: result }));
                return;
              }
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Unsupported action" }));
            } catch (e) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: `Invalid request: ${(e as Error).message}` }));
            }
          });
          return;
        }

        const tasks = readdirSync(tasksDir, { withFileTypes: true })
          .filter(d => d.isDirectory() && existsSync(join(tasksDir, d.name, "manifest.json")))
          .map(d => {
            try {
              return { name: d.name, manifest: JSON.parse(readFileSync(join(tasksDir, d.name, "manifest.json"), "utf-8")) };
            } catch {
              return { name: d.name, error: true };
            }
          });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(tasks));
      },
    });

    api.registerHttpRoute({
      path: "/taskflow/api/tasks/:id/stop",
      auth: "gateway",
      handler: async (req, res, params) => {
        if (String(req.method || "POST").toUpperCase() !== "POST") {
          res.writeHead(405, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Method not allowed" }));
          return;
        }
        let body = "";
        req.on("data", chunk => { body += String(chunk || ""); });
        req.on("end", async () => {
          try {
            const parsed = body ? JSON.parse(body) : {};
            const result = await panicStopPipeline(api, tasksDir, params.id, parsed.reason || "Dashboard stop button");
            res.writeHead(result.error ? 404 : 200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(result));
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: `Invalid request: ${(e as Error).message}` }));
          }
        });
      },
    });

    // Dashboard runs via PM2 (separate process, auto-restart, boot persistence)
    api.logger.info(`taskflow: dashboard expected on port ${dashboardPort} (managed by PM2)`);

    api.logger.info(`taskflow: plugin registered (tasks: ${tasksDir}, dashboard: ${dashboardPort})`);
  },
};

// ── Helpers ──

function findUnit(groups: Group[], unitId: string): Unit | null {
  const walk = (units: Unit[]): Unit | null => {
    for (const unit of units) {
      if (unit.id === unitId) return unit;
      if (unit.children?.length) {
        const found = walk(unit.children);
        if (found) return found;
      }
    }
    return null;
  };

  for (const g of groups) {
    const found = walk(g.children);
    if (found) return found;
  }
  return null;
}

function countStats(groups: Group[]) {
  let total = 0, done = 0, failed = 0, running = 0, blocked = 0, cancelled = 0;
  function walkUnits(units: Unit[]) {
    for (const u of units) {
      if (u.children?.length) { walkUnits(u.children); continue; }
      total++;
      if (u.status === "done") done++;
      else if (u.status === "failed") failed++;
      else if (u.status === "running") running++;
      else if (u.status === "blocked") blocked++;
      else if (u.status === "cancelled") cancelled++;
    }
  }
  for (const g of groups) walkUnits(g.children);
  return { total, done, failed, running, blocked, cancelled, pending: Math.max(0, total - done - failed - running - blocked - cancelled) };
}
