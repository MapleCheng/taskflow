/**
 * Taskflow v2 Schema Types
 */

// ── Unit (leaf or nested container) ──
export interface Unit {
  id: string;
  title: string;
  type?: string;            // e.g. "backend", "frontend", "db", "config"
  issue?: string;           // Reference to issues[].url
  unit?: string;            // Filename in units/ (e.g. "backend-1.md") — absent if has children
  children?: Unit[];        // Nested units (recursive)
  status: UnitStatus;
  startedAt?: string;       // ISO 8601
  completedAt?: string;     // ISO 8601
  note?: string;            // Summary on success
  error?: string;           // Error message on failure
}

// ── Group (pipeline-level container, children are always Units) ──
export interface Group {
  id: string;
  title: string;
  status: UnitStatus;
  completedAt?: string;     // ISO 8601
  children: Unit[];
}


// ── Issue ──
export interface Issue {
  url: string;              // e.g. "https://github.com/org/repo/issues/3"
  repo: string;             // e.g. "org/repo"
  number: number;           // e.g. 3
  path: string;             // Local repo path
  branch?: string;          // Git branch name
}

// ── Agent config (per-pipeline or per-unit override) ──
export interface AgentConfig {
  id?: string;              // Agent id (default: from plugin config)
  model?: string | null;    // Model override
  timeout?: number;         // Timeout in ms
}

// ── Manifest ──
export interface Manifest {
  id: string;               // = folder name, YYMMDDHHmmss format
  title: string;
  session: string;          // Notification target (e.g. "discord:channel:123")
  status: PipelineStatus;
  createdAt: string;        // ISO 8601
  startedAt?: string | null;
  completedAt?: string | null;
  issues?: Issue[];
  agent?: AgentConfig;      // Per-pipeline agent override
  pipeline: Group[];
}

// ── Status enums ──
export type UnitStatus = "pending" | "running" | "done" | "failed" | "skipped" | "blocked";
export type PipelineStatus = "pending" | "running" | "done" | "failed" | "stopped";

// ── Plugin config ──
export interface TaskflowPluginConfig {
  tasksDir?: string;
  dashboardPort?: number;
  dashboardSecret?: string;

  agent?: string;           // Default agent id (default: "main")
  model?: string | null;    // Default model override
  timeout?: number;         // Default unit timeout in ms
}

// ── Executor ──
export type UnitExecutor = (sessionKey: string, prompt: string) => Promise<UnitResult>;

export interface UnitResult {
  status: "done" | "failed";
  summary?: string;
  error?: string;
  sessionKey?: string;
}
