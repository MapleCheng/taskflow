/**
 * Taskflow Platform — deterministic pipeline runner
 * 
 * Reads manifest → finds pending unit → executes → updates status → next
 * State managed by platform, not AI.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

// ── Manifest helpers ──

export function readManifest(tasksDir, taskDir) {
  const p = join(tasksDir, taskDir, 'manifest.json');
  return JSON.parse(readFileSync(p, 'utf-8'));
}

export function writeManifest(tasksDir, taskDir, manifest) {
  const p = join(tasksDir, taskDir, 'manifest.json');
  writeFileSync(p, JSON.stringify(manifest, null, 2) + '\n');
}

export function readUnit(tasksDir, taskDir, unitFile) {
  const p = join(tasksDir, taskDir, 'units', unitFile);
  if (existsSync(p)) return readFileSync(p, 'utf-8');
  return null;
}

function ensureLogDir(tasksDir, taskDir) {
  const d = join(tasksDir, taskDir, 'logs');
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

export function writeLog(tasksDir, taskDir, unitId, text, append = true) {
  const p = join(ensureLogDir(tasksDir, taskDir), `${unitId}.log`);
  if (append) {
    appendFileSync(p, text);
  } else {
    writeFileSync(p, text);
  }
}

export function markUnitsStopped(nodes, reason, { includeRunning = true } = {}) {
  const stoppedAt = new Date().toISOString();
  for (const node of nodes) {
    if (node.children?.length) {
      markUnitsStopped(node.children, reason, { includeRunning });
      continue;
    }
    if (node.status === 'pending' || (includeRunning && node.status === 'running')) {
      node.status = 'cancelled';
      node.completedAt = node.completedAt || stoppedAt;
      node.error = node.error || reason || 'Pipeline stopped';
    }
  }
}

// ── Project derivation ──

/**
 * Derive a project identifier from a manifest.
 * Uses ALL issues[].path sorted and joined as the canonical project key.
 * This handles multi-repo projects (e.g. backend + frontend repos).
 * Returns null if no paths are available.
 */
export function deriveProject(manifest) {
  if (!manifest.issues?.length) return null;
  const paths = manifest.issues
    .map(i => i.path)
    .filter(Boolean)
    .sort();
  return paths.length > 0 ? paths.join('|') : null;
}

// ── Tree traversal / rollups ──

export function flattenExecutableUnits(groups) {
  const ordered = [];

  function walk(node, ancestors, indexes) {
    const nextAncestors = [...ancestors, node];
    const nextIndexes = [...indexes, node.id];
    if (node.children?.length) {
      node.children.forEach(child => walk(child, nextAncestors, nextIndexes));
      return;
    }
    if (!node.unit) return;
    const group = ancestors[0] || null;
    const unitAncestors = ancestors.slice(1);
    ordered.push({
      unit: node,
      group,
      groupId: group?.id || null,
      ancestors: unitAncestors,
      path: nextIndexes,
      pathKey: nextIndexes.join('/'),
      systemPromptLayers: [
        ...(group?.systemPrompt ? [group.systemPrompt] : []),
        ...unitAncestors.map(ancestor => ancestor.systemPrompt).filter(Boolean),
      ],
    });
  }

  groups.forEach(group => walk(group, [], []));
  return ordered;
}

function deriveNodeStatusFromChildren(children) {
  if (!children.length) return { status: 'pending', completedAt: undefined };
  const statuses = children.map(child => child.status || 'pending');

  if (statuses.some(status => status === 'running')) return { status: 'running', completedAt: undefined };
  if (statuses.some(status => status === 'failed')) return { status: 'failed', completedAt: undefined };
  if (statuses.some(status => status === 'blocked')) return { status: 'blocked', completedAt: undefined };
  if (statuses.some(status => status === 'cancelled')) {
    const allTerminal = statuses.every(status => status === 'done' || status === 'skipped' || status === 'cancelled');
    return { status: allTerminal ? 'cancelled' : 'running', completedAt: allTerminal ? new Date().toISOString() : undefined };
  }
  if (statuses.every(status => status === 'done' || status === 'skipped')) {
    const completedAt = children.reduce((latest, child) => {
      if (!child.completedAt) return latest;
      return !latest || child.completedAt > latest ? child.completedAt : latest;
    }, null);
    return { status: 'done', completedAt: completedAt || new Date().toISOString() };
  }
  return { status: 'pending', completedAt: undefined };
}

function rollupNodeStatuses(nodes) {
  for (const node of nodes) {
    if (!node.children?.length) continue;
    rollupNodeStatuses(node.children);
    const rolled = deriveNodeStatusFromChildren(node.children);
    node.status = rolled.status;
    if (rolled.completedAt) node.completedAt = rolled.completedAt;
    else delete node.completedAt;
  }
}

export function rollupPipelineStatuses(manifest) {
  if (!manifest?.pipeline) return manifest;
  rollupNodeStatuses(manifest.pipeline);
  return manifest;
}

export function findNextPendingExecutableUnit(groups) {
  const ordered = flattenExecutableUnits(groups);
  for (const entry of ordered) {
    if (entry.unit.status === 'pending') return entry;
    if (entry.unit.status === 'failed' || entry.unit.status === 'blocked' || entry.unit.status === 'running') return null;
  }
  return null;
}

export function isAllDone(nodes) {
  return flattenExecutableUnits(nodes).every(({ unit }) => (
    unit.status === 'done' || unit.status === 'skipped' || unit.status === 'cancelled'
  ));
}

export function countStats(nodes) {
  let total = 0, done = 0, failed = 0, running = 0, blocked = 0, cancelled = 0;
  function walk(list) {
    for (const n of list) {
      if (n.children?.length) { walk(n.children); continue; }
      total++;
      if (n.status === 'done') done++;
      else if (n.status === 'failed') failed++;
      else if (n.status === 'running') running++;
      else if (n.status === 'blocked') blocked++;
      else if (n.status === 'cancelled') cancelled++;
    }
  }
  walk(nodes);
  return { total, done, failed, running, blocked, cancelled, pending: Math.max(0, total - done - failed - running - blocked - cancelled) };
}

// ── Validation ──

const VALID_STATUSES = new Set(['pending', 'running', 'done', 'failed', 'skipped', 'blocked', 'cancelled']);

/**
 * Validate manifest against the v2 schema.
 * Throws on fatal errors, returns warnings for non-fatal issues.
 * Backward compatible: old manifests with 'issue'/'repoPath' still pass.
 */
export function validateManifest(manifest) {
  const errors = [];
  const warnings = [];

  // pipeline is the minimum requirement
  if (!manifest.pipeline || !Array.isArray(manifest.pipeline) || manifest.pipeline.length === 0) {
    errors.push('pipeline is required and must be a non-empty array');
  }

  if (!manifest.title) {
    errors.push('title is required');
  }
  if (!manifest.id) {
    errors.push('id is required');
  }
  // Validate issues array if present
  const issueUrls = new Set();
  if (manifest.issues && Array.isArray(manifest.issues)) {
    for (const issue of manifest.issues) {
      if (!issue.url) errors.push('each issue must have a url');
      if (!issue.repo) errors.push(`issue ${issue.url || '?'} must have a repo`);
      if (issue.number == null) errors.push(`issue ${issue.url || '?'} must have a number`);
      if (!issue.path) errors.push(`issue ${issue.url || '?'} must have a path`);
      if (issue.url) issueUrls.add(issue.url);
    }
  }

  // Validate pipeline items
  if (manifest.pipeline && Array.isArray(manifest.pipeline)) {
    const ids = new Set();

    function validateItem(item, path) {
      // Required fields
      if (!item.id) errors.push(`${path}: missing id`);
      if (!item.title) errors.push(`${path}: missing title`);

      // Unique id
      if (item.id) {
        if (ids.has(item.id)) errors.push(`${path}: duplicate id '${item.id}'`);
        ids.add(item.id);
      }

      // Mutual exclusivity: unit vs children
      if (item.unit && item.children) {
        errors.push(`${path}: 'unit' and 'children' are mutually exclusive`);
      }
      if (!item.unit && !item.children) {
        errors.push(`${path}: must have either 'unit' or 'children'`);
      }

      // Status whitelist
      if (item.status && !VALID_STATUSES.has(item.status)) {
        errors.push(`${path}: invalid status '${item.status}'`);
      }

      // Issue reference validation
      if (item.issue && issueUrls.size > 0 && !issueUrls.has(item.issue)) {
        errors.push(`${path}: issue '${item.issue}' not found in manifest.issues`);
      }
      if (item.issue && (!manifest.issues || manifest.issues.length === 0)) {
        errors.push(`${path}: has issue ref but manifest.issues is empty`);
      }

      // Recurse into children
      if (item.children && Array.isArray(item.children)) {
        for (let i = 0; i < item.children.length; i++) {
          validateItem(item.children[i], `${path}.children[${i}]`);
        }
      }
    }

    for (let i = 0; i < manifest.pipeline.length; i++) {
      // Top-level items must be groups (have children)
      if (!manifest.pipeline[i].children || manifest.pipeline[i].children.length === 0) {
        errors.push(`pipeline[${i}]: top-level items must be groups (must have children)`);
      }
      validateItem(manifest.pipeline[i], `pipeline[${i}]`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ── Working directory resolution ──

/**
 * Resolve working directory for a unit.
 * Priority: unit.issue → issues[].path > manifest.repoPath > cwd
 */
export function getUnitWorkDir(unit, manifest) {
  if (unit.issue && manifest.issues && Array.isArray(manifest.issues)) {
    const match = manifest.issues.find(i => i.url === unit.issue);
    if (match && match.path) return match.path;
  }
  // Fallback: first issue's path, then cwd
  if (manifest.issues && manifest.issues.length > 0 && manifest.issues[0].path) {
    return manifest.issues[0].path;
  }
  return process.cwd();
}

// ── Execution ──

/**
 * Build the agent prompt for a unit.
 */
export function buildUnitPrompt(unit, unitContent, manifest) {
  const parts = [
    `Working directory: ${getUnitWorkDir(unit, manifest)}`,
    '',
    unitContent,
  ];

  return parts.join('\n');
}

/**
 * Build the session key for a unit.
 */
export function buildUnitSessionKey(taskDir, unitId) {
  return `taskflow-${taskDir}-${unitId}`;
}

function formatExecutableUnitLabel(executableUnit) {
  if (!executableUnit?.unit) return 'unknown unit';
  const path = executableUnit.path?.join(' > ');
  return path
    ? `${executableUnit.unit.title} [${executableUnit.unit.id}] (${path})`
    : `${executableUnit.unit.title} [${executableUnit.unit.id}]`;
}

function findReporterFocusUnit(manifest) {
  const flattened = flattenExecutableUnits(manifest?.pipeline || []);
  const byId = new Map(flattened.map(entry => [entry.unit.id, entry]));
  const focusId = manifest?.failedUnitId || manifest?.currentUnitId;
  if (focusId && byId.has(focusId)) return byId.get(focusId);

  for (let index = flattened.length - 1; index >= 0; index--) {
    const entry = flattened[index];
    if (entry.unit.note || entry.unit.error) return entry;
  }

  for (let index = flattened.length - 1; index >= 0; index--) {
    const entry = flattened[index];
    if (entry.unit.status !== 'pending') return entry;
  }
  return null;
}

function getDurationMs(startedAt, completedAt) {
  if (!startedAt || !completedAt) return null;
  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  if (Number.isNaN(started) || Number.isNaN(completed)) return null;
  return Math.max(0, completed - started);
}

export function buildEndOfRunReporterPayload(manifest, { dashboardUrl } = {}) {
  if (!manifest || !['done', 'failed', 'stopped'].includes(manifest.status)) return null;

  const stats = countStats(manifest.pipeline || []);
  const runtime = manifest.run?.runtime || manifest.runtime || {};
  const focusEntry = findReporterFocusUnit(manifest);
  const focusUnit = focusEntry ? {
    id: focusEntry.unit.id,
    title: focusEntry.unit.title,
    status: focusEntry.unit.status,
    path: focusEntry.path,
    ...(focusEntry.unit.note ? { summary: focusEntry.unit.note } : {}),
    ...(focusEntry.unit.error ? { error: focusEntry.unit.error } : {}),
  } : undefined;

  // Build unitsSummary array with all executable units that have note or error
  const allUnits = flattenExecutableUnits(manifest.pipeline || []);
  const unitsSummary = allUnits
    .filter(entry => entry.unit.note || entry.unit.error)
    .map(entry => ({
      unitId: entry.unit.id,
      title: entry.unit.title,
      status: entry.unit.status,
      path: entry.path,
      ...(entry.unit.note ? { note: entry.unit.note } : {}),
      ...(entry.unit.error ? { error: entry.unit.error } : {}),
    }));

  return {
    type: 'taskflow.end-of-run',
    version: 1,
    task: {
      id: manifest.id,
      title: manifest.title,
      status: manifest.status,
    },
    manifest: {
      ...(dashboardUrl ? { dashboard: dashboardUrl } : {}),
    },
    runtime: {
      ...(runtime.mode ? { mode: runtime.mode } : {}),
      ...(runtime.source ? { source: runtime.source } : {}),
      startedAt: manifest.run?.startedAt || manifest.startedAt || null,
      completedAt: manifest.run?.completedAt || manifest.completedAt || null,
      durationMs: getDurationMs(
        manifest.run?.startedAt || manifest.startedAt || null,
        manifest.run?.completedAt || manifest.completedAt || null,
      ),
    },
    stats,
    ...(focusUnit ? { focusUnit } : {}),
    ...(unitsSummary.length > 0 ? { unitsSummary } : {}),
    summary: {
      ...(focusUnit?.summary ? { unit: focusUnit.summary } : {}),
      ...(manifest.status === 'stopped' && manifest.stopReason ? { error: manifest.stopReason } : {}),
      ...(manifest.status !== 'stopped' && focusUnit?.error ? { error: focusUnit.error } : {}),
      ...(manifest.status !== 'stopped' && !focusUnit?.error && manifest.lastError ? { error: manifest.lastError } : {}),
    },
  };
}

export function buildReporterPayload(manifest, stats) {
  if (!manifest || !['done', 'failed', 'stopped'].includes(manifest.status)) return null;

  const computedStats = stats || countStats(manifest.pipeline || []);
  const allUnits = flattenExecutableUnits(manifest.pipeline || []);
  const units = allUnits.map(entry => ({
    id: entry.unit.id,
    title: entry.unit.title,
    status: entry.unit.status,
    ...(entry.unit.note ? { note: entry.unit.note } : {}),
    ...(entry.unit.error ? { error: entry.unit.error } : {}),
  }));

  return {
    taskId: manifest.id,
    title: manifest.title,
    status: manifest.status,
    runtime: manifest.run?.runtime || manifest.runtime || {},
    stats: computedStats,
    ...(manifest.failedUnitId ? { failedUnitId: manifest.failedUnitId } : {}),
    ...(manifest.failedUnitPath ? { failedUnitPath: manifest.failedUnitPath } : {}),
    units,
  };
}

async function notifyEndOfRun(onNotify, _message, manifest, _opts) {
  if (typeof onNotify !== 'function') return;
  try {
    const payload = buildReporterPayload(manifest, null);
    await onNotify(manifest, payload);
  } catch (e) {
    // Reporter errors must not crash the pipeline
  }
}

/**
 * Execute a unit using the provided executor.
 * @param {function} executor - async (sessionKey, prompt) => { status, summary?, error? }
 */
export function buildExtraSystemPrompt(unit, manifest, { pluginSystemPrompt, executableUnit } = {}) {
  const flattened = executableUnit || flattenExecutableUnits(manifest.pipeline || []).find(entry => entry.unit.id === unit.id);
  const layers = [
    `You are executing a taskflow unit. Follow the instructions exactly.`,
    `After completing the task, your LAST line of output must be a JSON status:`,
    `{"status":"done","summary":"what you did"} or {"status":"failed","error":"what went wrong"}`,
  ];

  if (pluginSystemPrompt) layers.push(pluginSystemPrompt);
  if (manifest.systemPrompt) layers.push(manifest.systemPrompt);
  if (flattened?.systemPromptLayers?.length) layers.push(...flattened.systemPromptLayers);

  return layers.filter(Boolean).join('\n\n');
}

export async function executeUnit(tasksDir, taskDir, unit, manifest, { executor, pluginSystemPrompt, runtimeSelection, executableUnit } = {}) {
  const unitContent = readUnit(tasksDir, taskDir, unit.unit);
  if (!unitContent) {
    return { status: 'failed', error: 'Unit file not found: ' + unit.unit };
  }

  const sessionKey = buildUnitSessionKey(taskDir, unit.id);
  const prompt = buildUnitPrompt(unit, unitContent, manifest);
  const extraSystemPrompt = buildExtraSystemPrompt(unit, manifest, { pluginSystemPrompt, executableUnit });

  writeLog(
    tasksDir,
    taskDir,
    unit.id,
    `[Session: ${sessionKey}]\n[Runtime: ${runtimeSelection?.mode || manifest?.run?.runtime?.mode || manifest?.runtime?.mode || manifest?.agent?.runtime || 'subagent'} | Source: ${runtimeSelection?.source || manifest?.run?.runtime?.source || manifest?.runtime?.source || 'unknown'}]\n[Prompt sent, waiting for response...]\n\n`,
    false,
  );

  try {
    const result = await executor(sessionKey, prompt, extraSystemPrompt || undefined);
    writeLog(tasksDir, taskDir, unit.id, `[Result: ${JSON.stringify({ ...result, runtime: result.runtime || runtimeSelection?.mode })}]\n`);
    return result;
  } catch (e) {
    const error = (e.message || String(e)).slice(-500);
    writeLog(tasksDir, taskDir, unit.id, `[Error: ${error}]\n`);
    return { status: 'failed', error, sessionKey };
  }
}

// ── Main loop ──

/**
 * Run a pipeline.
 * @param {string} tasksDir
 * @param {string} taskDir
 * @param {object} opts
 * @param {function} opts.executor - async (sessionKey, prompt) => { status, summary?, error? }
 * @param {function} [opts.onNotify] - (message, manifest, payload?) => void
 * @param {object} [opts.logger]
 */
export async function runPipeline(tasksDir, taskDir, { executor, pluginSystemPrompt, onNotify, logger, shouldStop, runtimeSelection, dashboardUrl } = {}) {
  if (!executor) throw new Error('executor is required');
  const log = logger || console;
  log.info(`🔥 Taskflow Platform starting: ${taskDir} (runtime=${runtimeSelection?.mode || 'subagent'}, source=${runtimeSelection?.source || 'unknown'})`);

  const manifest = readManifest(tasksDir, taskDir);
  manifest._taskDir = taskDir;

  // Validate manifest before running
  const validation = validateManifest(manifest);
  if (!validation.valid) {
    log.info(`❌ Manifest validation failed:\n  ${validation.errors.join('\n  ')}`);
    manifest.status = 'failed';
    manifest.completedAt = new Date().toISOString();
    manifest.run = {
      ...(manifest.run || {}),
      runtime: runtimeSelection || manifest.run?.runtime || manifest.runtime,
      completedAt: manifest.completedAt,
    };
    writeManifest(tasksDir, taskDir, manifest);
    await notifyEndOfRun(onNotify, `❌ Manifest validation failed: ${validation.errors[0]}`, manifest, { dashboardUrl });
    return;
  }
  if (validation.warnings.length > 0) {
    log.info(`⚠️ Manifest warnings:\n  ${validation.warnings.join('\n  ')}`);
  }
  rollupPipelineStatuses(manifest);

  manifest.status = 'running';
  manifest.startedAt = manifest.startedAt || new Date().toISOString();
  manifest.run = {
    ...(manifest.run || {}),
    runtime: runtimeSelection || manifest.run?.runtime || manifest.runtime,
    startedAt: new Date().toISOString(),
    completedAt: null,
  };
  writeManifest(tasksDir, taskDir, manifest);

  while (true) {
    rollupPipelineStatuses(manifest);

    if (shouldStop && shouldStop()) {
      manifest.status = 'stopped';
      manifest.stopRequestedAt = manifest.stopRequestedAt || new Date().toISOString();
      manifest.stopReason = manifest.stopReason || 'Pipeline stopped';
      manifest.run = {
        ...(manifest.run || {}),
        runtime: runtimeSelection || manifest.run?.runtime || manifest.runtime,
        completedAt: new Date().toISOString(),
      };
      markUnitsStopped(manifest.pipeline, manifest.stopReason, { includeRunning: true });
      rollupPipelineStatuses(manifest);
      writeManifest(tasksDir, taskDir, manifest);
      const msg = `🛑 Pipeline stopped: ${manifest.issue || taskDir}`;
      log.info(msg);
      await notifyEndOfRun(onNotify, msg, manifest, { dashboardUrl });
      break;
    }

    const nextExecutable = findNextPendingExecutableUnit(manifest.pipeline);
    const unit = nextExecutable?.unit || null;

    if (!unit) {
      rollupPipelineStatuses(manifest);
      if (isAllDone(manifest.pipeline)) {
        manifest.status = 'done';
        manifest.completedAt = new Date().toISOString();
        manifest.run = {
          ...(manifest.run || {}),
          runtime: runtimeSelection || manifest.run?.runtime || manifest.runtime,
          completedAt: manifest.completedAt,
        };
        writeManifest(tasksDir, taskDir, manifest);

        const stats = countStats(manifest.pipeline);
        const msg = `✅ Pipeline complete: ${manifest.issue || taskDir}\n${stats.done}/${stats.total} units done`;
        log.info(msg);
        await notifyEndOfRun(onNotify, msg, manifest, { dashboardUrl });
        break;
      } else {
        const stats = countStats(manifest.pipeline);
        const hasFailure = stats.failed > 0;
        manifest.status = hasFailure ? 'failed' : 'stopped';
        manifest.completedAt = manifest.completedAt || new Date().toISOString();
        manifest.run = {
          ...(manifest.run || {}),
          runtime: runtimeSelection || manifest.run?.runtime || manifest.runtime,
          completedAt: manifest.completedAt,
        };
        writeManifest(tasksDir, taskDir, manifest);

        const msg = hasFailure
          ? `❌ Pipeline failed: ${manifest.issue || taskDir}\nDone: ${stats.done}, Failed: ${stats.failed}, Blocked: ${stats.blocked}`
          : `⚠️ Pipeline stopped: ${manifest.issue || taskDir}\nDone: ${stats.done}, Failed: ${stats.failed}, Blocked: ${stats.blocked}`;
        log.info(msg);
        await notifyEndOfRun(onNotify, msg, manifest, { dashboardUrl });
        break;
      }
    }

    manifest.currentUnitId = unit.id;
    manifest.currentUnitPath = nextExecutable.path;
    unit.status = 'running';
    unit.startedAt = new Date().toISOString();
    rollupPipelineStatuses(manifest);
    writeManifest(tasksDir, taskDir, manifest);

    const stats = countStats(manifest.pipeline);
    log.info(`[${stats.done + 1}/${stats.total}] Running: ${formatExecutableUnitLabel(nextExecutable)} (${unit.type || 'task'})`);

    const result = await executeUnit(tasksDir, taskDir, unit, manifest, {
      executor,
      pluginSystemPrompt,
      runtimeSelection,
      executableUnit: nextExecutable,
    });

    if (shouldStop && shouldStop()) {
      unit.status = 'cancelled';
      unit.completedAt = new Date().toISOString();
      if (result.summary) unit.note = result.summary;
      unit.error = result.error || manifest.stopReason || 'Pipeline stopped';
      manifest.status = 'stopped';
      manifest.stopRequestedAt = manifest.stopRequestedAt || new Date().toISOString();
      manifest.stopReason = manifest.stopReason || result.error || 'Pipeline stopped';
      manifest.failedUnitId = unit.id;
      manifest.failedUnitPath = nextExecutable.path;
      manifest.lastError = result.error || manifest.stopReason || 'Pipeline stopped';
      manifest.run = {
        ...(manifest.run || {}),
        runtime: runtimeSelection || manifest.run?.runtime || manifest.runtime,
        completedAt: new Date().toISOString(),
      };
      markUnitsStopped(manifest.pipeline, manifest.stopReason, { includeRunning: false });
      rollupPipelineStatuses(manifest);
      writeManifest(tasksDir, taskDir, manifest);
      const msg = `🛑 Pipeline stopped during unit: ${formatExecutableUnitLabel(nextExecutable)}`;
      log.info(msg);
      await notifyEndOfRun(onNotify, msg, manifest, { dashboardUrl });
      break;
    }

    unit.status = result.status;
    unit.completedAt = new Date().toISOString();
    if (result.summary) unit.note = result.summary;
    if (result.error) unit.error = result.error;
    if (result.status === 'failed') {
      manifest.failedUnitId = unit.id;
      manifest.failedUnitPath = nextExecutable.path;
      manifest.lastError = result.error || 'Unit failed';
    } else {
      delete manifest.failedUnitId;
      delete manifest.failedUnitPath;
      if (manifest.lastError === unit.error) delete manifest.lastError;
      delete manifest.currentUnitId;
      delete manifest.currentUnitPath;
    }

    rollupPipelineStatuses(manifest);
    writeManifest(tasksDir, taskDir, manifest);

    if (result.status === 'done') {
      log.info(`   ✅ Done: ${result.summary?.slice(0, 80) || 'OK'}`);
    } else {
      log.info(`   ❌ Failed: ${formatExecutableUnitLabel(nextExecutable)} :: ${result.error?.slice(0, 120) || 'unknown'}`);
    }

    await new Promise(r => setTimeout(r, 500));
  }

  log.info('🔥 Platform exiting.');
}
