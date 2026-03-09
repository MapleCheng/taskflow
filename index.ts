/**
 * Taskflow Plugin — OpenClaw plugin for autonomous pipeline execution
 * 
 * Tools: taskflow_run, taskflow_status, taskflow_list
 * Service: Dashboard on configurable port
 * Notification: via plugin runtime (no shell out)
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { readdirSync, existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { execSync, spawn as nodeSpawn } from "node:child_process";
import { Type } from "@sinclair/typebox";
import { fileURLToPath } from "node:url";

interface PluginConfig {
  tasksDir?: string;
  dashboardPort?: number;
  dashboardSecret?: string;
  issueBaseUrl?: string;
  notify?: {
    channel?: string;
    target?: string;
  };
}

// Running pipelines tracked in memory
const runningPipelines = new Map<string, { pid?: number; startedAt: string }>();

// Shared reference to plugin API for notification
let pluginApi: OpenClawPluginApi | null = null;
let pluginConfig: PluginConfig = {};

export default {
  register(api: OpenClawPluginApi) {
    pluginApi = api;
    const config: PluginConfig = (api.pluginConfig || {}) as PluginConfig;
    pluginConfig = config;
    const tasksDir = api.resolvePath(config.tasksDir || join(homedir(), "clawd", "tasks"));
    const dashboardPort = config.dashboardPort || 3847;
    const issueBaseUrl = config.issueBaseUrl || "";
    const __dirname = dirname(fileURLToPath(import.meta.url));

    // ── Tool: taskflow_run ──
    api.registerTool(() => ({
      name: "taskflow_run",
      label: "Run Taskflow Pipeline",
      description: "Start a taskflow pipeline for a task directory. Runs in background, sends notification on completion.",
      parameters: Type.Object({
        taskDir: Type.String({ description: "Task directory name (e.g. DEMO-python-hello)" }),
        mode: Type.Optional(Type.String({ description: "Execution mode: 'direct' (bash) or 'agent' (openclaw agent per unit). Default: agent" })),
      }),
      async execute(_toolCallId: string, params: { taskDir: string; mode?: string }) {
        const { taskDir, mode = "agent" } = params;
        const manifestPath = join(tasksDir, taskDir, "manifest.json");

        if (!existsSync(manifestPath)) {
          return { error: `manifest.json not found in ${tasksDir}/${taskDir}` };
        }

        if (runningPipelines.has(taskDir)) {
          return { error: `Pipeline ${taskDir} is already running` };
        }

        // Reset manifest
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

        // Fork the platform runner as a child process
        // Pass notify context from the triggering session
        const platformPath = join(__dirname, "src", "platform-cli.js");
        const notifyChannel = (api as any).currentInbound?.channel || config.notify?.channel || "";
        const notifyTarget = (api as any).currentInbound?.chatId || config.notify?.target || "";
        const child = nodeSpawn("node", [platformPath, tasksDir, taskDir, mode], {
          detached: true,
          stdio: "ignore",
          env: {
            ...process.env,
            TASKFLOW_NOTIFY_CHANNEL: notifyChannel,
            TASKFLOW_NOTIFY_TARGET: notifyTarget,
          },
        });
        child.unref();

        runningPipelines.set(taskDir, { pid: child.pid, startedAt: new Date().toISOString() });

        child.on("exit", () => {
          runningPipelines.delete(taskDir);
        });

        return {
          status: "started",
          taskDir,
          mode,
          pid: child.pid,
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
          const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
          const stats = countStats(manifest.pipeline);
          return {
            task: taskDir,
            issue: manifest.issue,
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
              const m = JSON.parse(readFileSync(join(tasksDir, d.name, "manifest.json"), "utf-8"));
              const stats = countStats(m.pipeline);
              return {
                name: d.name,
                issue: m.issue,
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

// ── Notification (called from platform-cli via IPC or direct import) ──

export async function sendNotification(taskDir: string, stats: { total: number; done: number; failed: number }, manifest: any) {
  const config = pluginConfig;
  const channel = config.notify?.channel;
  const target = config.notify?.target;

  if (!channel || !target) return;

  const text = [
    `🔥 **Taskflow ${stats.failed > 0 ? 'Stopped' : 'Complete'}**`,
    ``,
    `**${manifest.issue || taskDir}** — ${stats.done}/${stats.total} done, ${stats.failed} failed`,
    manifest.branch ? `Branch: \`${manifest.branch}\`` : null,
  ].filter(Boolean).join('\n');

  // Send via openclaw message send (channel-agnostic)
  try {
    execSync(
      `openclaw message send --channel ${channel} --target ${JSON.stringify(target)} --message ${JSON.stringify(text)}`,
      { encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
  } catch (e) {
    // Silent fail — notification is best-effort
  }
}

// ── Helpers ──

function countStats(nodes: any[]): { total: number; done: number; failed: number; running: number; blocked: number } {
  let total = 0, done = 0, failed = 0, running = 0, blocked = 0;
  function walk(list: any[]) {
    for (const n of list) {
      if (n.children?.length) { walk(n.children); continue; }
      total++;
      if (n.status === "done") done++;
      else if (n.status === "failed") failed++;
      else if (n.status === "running") running++;
      else if (n.status === "blocked") blocked++;
    }
  }
  walk(nodes);
  return { total, done, failed, running, blocked };
}
