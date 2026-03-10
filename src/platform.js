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

// ── Tree traversal ──

export function findNextPending(nodes) {
  for (const node of nodes) {
    if (node.children && node.children.length > 0) {
      const child = findNextPending(node.children);
      if (child) return child;
      if (node.children.every(c => c.status === 'done' || c.status === 'skipped')) {
        if (node.status !== 'done') {
          node.status = 'done';
          node.completedAt = new Date().toISOString();
        }
      }
      continue;
    }
    if (node.status === 'pending') return node;
    if (node.status === 'failed' || node.status === 'blocked') return null;
  }
  return null;
}

export function isAllDone(nodes) {
  for (const node of nodes) {
    if (node.children && node.children.length > 0) {
      if (!isAllDone(node.children)) return false;
      continue;
    }
    if (node.status !== 'done' && node.status !== 'skipped') return false;
  }
  return true;
}

export function countStats(nodes) {
  let total = 0, done = 0, failed = 0, running = 0, blocked = 0;
  function walk(list) {
    for (const n of list) {
      if (n.children?.length) { walk(n.children); continue; }
      total++;
      if (n.status === 'done') done++;
      else if (n.status === 'failed') failed++;
      else if (n.status === 'running') running++;
      else if (n.status === 'blocked') blocked++;
    }
  }
  walk(nodes);
  return { total, done, failed, running, blocked };
}

// ── Validation ──

const VALID_STATUSES = new Set(['pending', 'running', 'done', 'failed', 'skipped', 'blocked']);

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
  if (!manifest.session) {
    errors.push('session is required');
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
  return [
    `You are executing a taskflow unit. Follow the instructions exactly.`,
    `After completing the task, your LAST line of output must be a JSON status:`,
    `{"status":"done","summary":"what you did"} or {"status":"failed","error":"what went wrong"}`,
    ``,
    `Working directory: ${getUnitWorkDir(unit, manifest)}`,
    ``,
    `--- UNIT PROMPT ---`,
    unitContent,
    `--- END UNIT ---`,
  ].join('\n');
}

/**
 * Build the session key for a unit.
 */
export function buildUnitSessionKey(taskDir, unitId) {
  return `taskflow-${taskDir}-${unitId}`;
}

/**
 * Execute a unit using the provided executor.
 * @param {object} opts
 * @param {function} opts.executor - async (sessionKey, prompt) => { status, summary?, error? }
 */
export async function executeUnit(tasksDir, taskDir, unit, manifest, { executor }) {
  const unitContent = readUnit(tasksDir, taskDir, unit.unit);
  if (!unitContent) {
    return { status: 'failed', error: 'Unit file not found: ' + unit.unit };
  }

  const sessionKey = buildUnitSessionKey(taskDir, unit.id);
  const prompt = buildUnitPrompt(unit, unitContent, manifest);

  writeLog(tasksDir, taskDir, unit.id, `[Session: ${sessionKey}]\n[Prompt sent, waiting for response...]\n\n`, false);

  try {
    const result = await executor(sessionKey, prompt);
    writeLog(tasksDir, taskDir, unit.id, `[Result: ${JSON.stringify(result)}]\n`);
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
 * @param {function} [opts.onNotify] - (message, manifest) => void
 * @param {object} [opts.logger]
 */
export async function runPipeline(tasksDir, taskDir, { executor, onNotify, logger } = {}) {
  if (!executor) throw new Error('executor is required');
  const log = logger || console;
  log.info(`🔥 Taskflow Platform starting: ${taskDir}`);

  const manifest = readManifest(tasksDir, taskDir);
  manifest._taskDir = taskDir;

  // Validate manifest before running
  const validation = validateManifest(manifest);
  if (!validation.valid) {
    log.info(`❌ Manifest validation failed:\n  ${validation.errors.join('\n  ')}`);
    manifest.status = 'failed';
    writeManifest(tasksDir, taskDir, manifest);
    if (onNotify) onNotify(`❌ Manifest validation failed: ${validation.errors[0]}`, manifest);
    return;
  }
  if (validation.warnings.length > 0) {
    log.info(`⚠️ Manifest warnings:\n  ${validation.warnings.join('\n  ')}`);
  }

  manifest.status = 'running';
  manifest.startedAt = manifest.startedAt || new Date().toISOString();
  writeManifest(tasksDir, taskDir, manifest);

  while (true) {
    const unit = findNextPending(manifest.pipeline);

    if (!unit) {
      if (isAllDone(manifest.pipeline)) {
        manifest.status = 'done';
        manifest.completedAt = new Date().toISOString();
        writeManifest(tasksDir, taskDir, manifest);

        const stats = countStats(manifest.pipeline);
        const msg = `✅ Pipeline complete: ${manifest.issue || taskDir}\n${stats.done}/${stats.total} units done`;
        log.info(msg);
        if (onNotify) onNotify(msg, manifest);
        break;
      } else {
        manifest.status = 'stopped';
        writeManifest(tasksDir, taskDir, manifest);

        const stats = countStats(manifest.pipeline);
        const msg = `⚠️ Pipeline stopped: ${manifest.issue || taskDir}\nDone: ${stats.done}, Failed: ${stats.failed}, Blocked: ${stats.blocked}`;
        log.info(msg);
        if (onNotify) onNotify(msg, manifest);
        break;
      }
    }

    unit.status = 'running';
    unit.startedAt = new Date().toISOString();
    writeManifest(tasksDir, taskDir, manifest);

    const stats = countStats(manifest.pipeline);
    log.info(`[${stats.done + 1}/${stats.total}] Running: ${unit.title} (${unit.type || 'task'})`);

    const result = await executeUnit(tasksDir, taskDir, unit, manifest, { executor });

    unit.status = result.status;
    unit.completedAt = new Date().toISOString();
    if (result.summary) unit.note = result.summary;
    if (result.error) unit.error = result.error;

    writeManifest(tasksDir, taskDir, manifest);

    if (result.status === 'done') {
      log.info(`   ✅ Done: ${result.summary?.slice(0, 80) || 'OK'}`);
    } else {
      log.info(`   ❌ ${result.status}: ${result.error?.slice(0, 120) || 'unknown'}`);
    }

    findNextPending(manifest.pipeline);
    writeManifest(tasksDir, taskDir, manifest);

    await new Promise(r => setTimeout(r, 500));
  }

  log.info('🔥 Platform exiting.');
}
