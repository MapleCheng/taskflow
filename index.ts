/**
 * Taskflow Plugin — OpenClaw plugin for autonomous pipeline execution
 * 
 * Tools: taskflow_run, taskflow_status, taskflow_list
 * Service: Dashboard on configurable port
 * Notification: via plugin runtime (no shell out)
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { Manifest, Group, Unit, Issue, TaskflowPluginConfig, UnitExecutor, UnitResult } from "./src/types.js";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { readdirSync, existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { Type } from "@sinclair/typebox";
import { fileURLToPath } from "node:url";

// Running pipelines tracked in memory
const runningPipelines = new Map<string, { startedAt: string }>();

// Shared reference to plugin API
let pluginApi: OpenClawPluginApi | null = null;

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
        session: Type.String({ description: "OpenClaw session id for notifications (e.g. discord:channel:123)" }),
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
        session: string;
        issues?: Array<{ url: string; repo: string; number: number; path: string; branch?: string }>;
        units: Array<{
          id: string;
          title: string;
          issue?: string;
          prompt?: string;
          children?: Array<{ id: string; title: string; issue?: string; prompt: string }>;
        }>;
      }) {
        const { title, session, issues, units } = params;

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
            status: "pending" as const,
            children,
          };
        });

        // Build manifest
        const manifest: Manifest = {
          id,
          title,
          session,
          status: "pending",
          createdAt: new Date().toISOString(),
          startedAt: null,
          completedAt: null,
          ...(issues && issues.length > 0 ? { issues: issues as Issue[] } : {}),
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
        taskDir: Type.String({ description: "Task directory name (e.g. DEMO-python-hello)" }),
      }),
      async execute(_toolCallId: string, params: { taskDir: string }) {
        const { taskDir } = params;
        const manifestPath = join(tasksDir, taskDir, "manifest.json");

        if (!existsSync(manifestPath)) {
          return { error: `manifest.json not found in ${tasksDir}/${taskDir}` };
        }

        if (runningPipelines.has(taskDir)) {
          return { error: `Pipeline ${taskDir} is already running` };
        }

        runningPipelines.set(taskDir, { startedAt: new Date().toISOString() });

        // Build executor using plugin runtime API
        const agentId = config.agent || "main";
        const unitTimeout = config.timeout || 300000;

        const executor: UnitExecutor = async (sessionKey, prompt) => {
          // Use subagent.run() to execute the unit
          const { runId } = await api.runtime.subagent.run({
            sessionKey,
            message: prompt,
            lane: agentId !== "main" ? agentId : undefined,
            idempotencyKey: `taskflow-${sessionKey}-${Date.now()}`,
          });

          // Wait for completion
          const waitResult = await api.runtime.subagent.waitForRun({
            runId,
            timeoutMs: unitTimeout,
          });

          if (waitResult.status === "timeout") {
            return { status: "failed", error: `Unit timed out after ${unitTimeout}ms`, sessionKey };
          }
          if (waitResult.status === "error") {
            return { status: "failed", error: waitResult.error || "Agent error", sessionKey };
          }

          // Read session messages to extract result
          const { messages } = await api.runtime.subagent.getSessionMessages({
            sessionKey,
            limit: 5,
          });

          // Find the last assistant message with a JSON status
          for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i] as any;
            if (msg.role === "assistant" && msg.content) {
              const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
              const lines = text.trim().split("\n");
              for (let j = lines.length - 1; j >= Math.max(0, lines.length - 5); j--) {
                try {
                  const parsed = JSON.parse(lines[j].trim());
                  if (parsed.status) return { ...parsed, sessionKey };
                } catch (_) {}
              }
            }
          }

          return { status: "done", summary: "Agent completed (no explicit status)", sessionKey };
        };

        // Notification via system event
        const onNotify = (message: string, manifest: Manifest) => {
          if (manifest.session) {
            try {
              api.runtime.system.enqueueSystemEvent(message, {
                sessionKey: manifest.session,
              });
            } catch (e) {
              api.logger.warn(`taskflow: notification failed: ${(e as Error).message}`);
            }
          }
        };

        // Run pipeline in background (non-blocking)
        const { runPipeline } = await import("./src/platform.js");
        runPipeline(tasksDir, taskDir, {
          executor,
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
          agent: agentId,
          dashboard: `http://localhost:${dashboardPort}`,
        };
      },
    }));

    // ── Tool: taskflow_status ──
    api.registerTool(() => ({
      name: "taskflow_status",
      label: "Taskflow Status",
      description: "Get the status of a taskflow pipeline, including unit progress and timing.",
      parameters: Type.Object({
        taskDir: Type.String({ description: "Task directory name" }),
      }),
      async execute(_toolCallId: string, params: { taskDir: string }) {
        const { taskDir } = params;
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
            running: runningPipelines.has(taskDir),
            dashboard: `http://localhost:${dashboardPort}`,
          };
        } catch (e) {
          return { error: `Failed to read manifest: ${(e as Error).message}` };
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

    // Dashboard runs via PM2 (separate process, auto-restart, boot persistence)
    api.logger.info(`taskflow: dashboard expected on port ${dashboardPort} (managed by PM2)`);

    api.logger.info(`taskflow: plugin registered (tasks: ${tasksDir}, dashboard: ${dashboardPort})`);
  },
};

// ── Helpers ──

function countStats(groups: Group[]) {
  let total = 0, done = 0, failed = 0, running = 0, blocked = 0;
  function walkUnits(units: Unit[]) {
    for (const u of units) {
      if (u.children?.length) { walkUnits(u.children); continue; }
      total++;
      if (u.status === "done") done++;
      else if (u.status === "failed") failed++;
      else if (u.status === "running") running++;
      else if (u.status === "blocked") blocked++;
    }
  }
  for (const g of groups) walkUnits(g.children);
  return { total, done, failed, running, blocked };
}
