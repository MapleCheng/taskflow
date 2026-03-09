/**
 * Taskflow Platform — deterministic pipeline runner
 * 
 * Reads manifest → finds pending unit → executes → updates status → next
 * State managed by platform, not AI.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

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

// ── Execution ──

function executeDirect(unitContent, manifest, tasksDir, taskDir, unitId) {
  let command = '';
  const match = unitContent.match(/```(?:bash|sh)\n([\s\S]*?)```/);
  if (match) command = match[1].trim();

  if (!command) {
    return { status: 'failed', error: 'No executable command found in unit file' };
  }

  const cwd = manifest.repoPath || process.cwd();
  if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true });

  writeLog(tasksDir, taskDir, unitId, `$ ${command}\n\n`, false);

  try {
    const output = execSync(command, {
      cwd,
      encoding: 'utf-8',
      timeout: 60000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    writeLog(tasksDir, taskDir, unitId, output + `\n[exit code: 0]\n`);
    return { status: 'done', summary: output.trim().slice(-200) || 'OK' };
  } catch (e) {
    const stderr = (e.stderr || '').toString();
    const stdout = (e.stdout || '').toString();
    writeLog(tasksDir, taskDir, unitId, stdout + `\n[stderr] ${stderr}\n[exit code: ${e.status}]\n`);
    return {
      status: 'failed',
      error: (stderr || stdout || e.message).trim().slice(-500)
    };
  }
}

function executeViaAgent(tasksDir, taskDir, unit, unitContent, manifest) {
  const sessionId = `taskflow-${taskDir}-${unit.id}`;
  const prompt = [
    `You are executing a taskflow unit. Follow the instructions exactly.`,
    `After completing the task, your LAST line of output must be a JSON status:`,
    `{"status":"done","summary":"what you did"} or {"status":"failed","error":"what went wrong"}`,
    ``,
    `Working directory: ${manifest.repoPath || '/tmp'}`,
    ``,
    `--- UNIT SPEC ---`,
    unitContent,
    `--- END UNIT ---`,
  ].join('\n');

  writeLog(tasksDir, taskDir, unit.id, `[Agent Session: ${sessionId}]\n[Prompt sent, waiting for response...]\n\n`, false);

  try {
    const output = execSync(
      `openclaw agent --session-id "${sessionId}" --message ${JSON.stringify(prompt)}`,
      {
        encoding: 'utf-8',
        timeout: 300000,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, HOME: process.env.HOME }
      }
    );

    const lines = output.trim().split('\n');
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
      try {
        const parsed = JSON.parse(lines[i].trim());
        if (parsed.status) return parsed;
      } catch (_) {}
    }

    writeLog(tasksDir, taskDir, unit.id, output);
    return { status: 'done', summary: output.trim().slice(-300), sessionId };
  } catch (e) {
    return {
      status: 'failed',
      error: (e.stderr || e.message || '').trim().slice(-500),
      sessionId
    };
  }
}

export async function executeUnit(tasksDir, taskDir, unit, manifest, mode = 'direct') {
  const unitContent = readUnit(tasksDir, taskDir, unit.unit);
  if (!unitContent) {
    return { status: 'failed', error: 'Unit file not found: ' + unit.unit };
  }

  if (mode === 'agent') {
    return executeViaAgent(tasksDir, taskDir, unit, unitContent, manifest);
  } else {
    return executeDirect(unitContent, manifest, tasksDir, taskDir, unit.id);
  }
}

// ── Main loop ──

export async function runPipeline(tasksDir, taskDir, mode = 'direct', { onNotify, logger } = {}) {
  const log = logger || console;
  log.info(`🔥 Taskflow Platform starting: ${taskDir}`);

  const manifest = readManifest(tasksDir, taskDir);
  manifest._taskDir = taskDir;
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

    const result = await executeUnit(tasksDir, taskDir, unit, manifest, mode);

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
