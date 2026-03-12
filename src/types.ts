/**
 * Taskflow v2 Schema Types
 */

// ── Unit (leaf or nested container) ──
export interface Unit {
  id: string;
  title: string;
  type?: string;            // e.g. "backend", "frontend", "db", "config"
  issue?: string;           // Reference to issues[].url
  systemPrompt?: string;    // Optional nested container prompt layer
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
  systemPrompt?: string;    // Optional group-level system prompt layered above unit prompt
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
export type RuntimeMode = "subagent";

export interface AgentConfig {
  id?: string;              // Agent id (default: from plugin config)
  model?: string | null;    // Model override
  timeout?: number;         // Timeout in ms
  runtime?: RuntimeMode;    // Legacy runtime override (default: subagent)
}

export interface RuntimeSelection {
  mode: RuntimeMode;
  source?: "plugin-config" | "manifest.runtime" | "manifest.agent.runtime" | "taskflow_run";
}

export interface RunState {
  runtime?: RuntimeSelection;
  startedAt?: string | null;
  completedAt?: string | null;
  reporter?: ReporterTrace;
}

export interface ReporterTrace {
  runtime: RuntimeMode;
  status: "running" | "sent" | "failed";
  finalStatus?: PipelineStatus;
  attemptedAt?: string | null;
  completedAt?: string | null;
  targetSession?: string;
  reporterSessionKey?: string;
  reporterRunId?: string;
  deliveryMethod?: string;
  error?: string | null;
}

export interface ReporterUnitSummary {
  id: string;
  title: string;
  status: UnitStatus;
  path?: string[];
  summary?: string;
  error?: string;
}

export interface EndOfRunReporterPayload {
  type: "taskflow.end-of-run";
  version: 1;
  task: {
    id: string;
    title: string;
    status: PipelineStatus;
  };
  manifest: {
    dashboard?: string;
  };
  runtime: {
    mode?: RuntimeMode;
    source?: RuntimeSelection["source"];
    startedAt?: string | null;
    completedAt?: string | null;
    durationMs?: number | null;
  };
  stats: {
    total: number;
    done: number;
    failed: number;
    running: number;
    blocked: number;
    cancelled: number;
    pending: number;
  };
  focusUnit?: ReporterUnitSummary;
  summary: {
    unit?: string;
    error?: string;
  };
}

// ── Manifest ──
export interface Manifest {
  id: string;               // = folder name, YYMMDDHHmmss format
  title: string;
  status: PipelineStatus;
  createdAt: string;        // ISO 8601
  startedAt?: string | null;
  completedAt?: string | null;
  issues?: Issue[];
  systemPrompt?: string;    // Optional pipeline-level system prompt layered above unit prompt
  agent?: AgentConfig;      // Per-pipeline agent override
  runtime?: RuntimeSelection; // Explicit runtime selection from pipeline authoring/dev skill
  run?: RunState;           // Effective runtime and timestamps for the latest run
  stopRequestedAt?: string | null;
  stopReason?: string | null;
  currentUnitId?: string;
  currentUnitPath?: string[];
  failedUnitId?: string;
  failedUnitPath?: string[];
  lastError?: string;
  pipeline: Group[];
}

// ── Status enums ──
export type UnitStatus = "pending" | "running" | "done" | "failed" | "skipped" | "blocked" | "cancelled";
export type PipelineStatus = "pending" | "running" | "done" | "failed" | "stopped";

// ── Plugin config ──
export interface TaskflowPluginConfig {
  tasksDir?: string;
  dashboardPort?: number;
  dashboardSecret?: string;

  systemPrompt?: string;    // Global system prompt layered into extraSystemPrompt
  agent?: string;           // Default agent id (default: "main")
  model?: string | null;    // Default model override
  timeout?: number;         // Default unit timeout in ms
  runtime?: RuntimeMode;    // Default runtime mode (default: subagent)
}

// ── Executor ──
export type UnitExecutor = (sessionKey: string, prompt: string, extraSystemPrompt?: string) => Promise<UnitResult>;
export type NotifyFn = (manifest: Manifest, payload: Record<string, unknown>) => void | Promise<void>;

export interface UnitResult {
  status: "done" | "failed";
  summary?: string;
  error?: string;
  sessionKey?: string;
  runtime?: RuntimeMode;
}
