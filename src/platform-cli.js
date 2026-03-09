#!/usr/bin/env node
/**
 * Taskflow Platform CLI — child process entry point
 * Called by the plugin via spawn()
 * 
 * Args: <tasksDir> <taskDir> <mode>
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPipeline, countStats } from './platform.js';

const [tasksDir, taskDir, mode] = process.argv.slice(2);

if (!tasksDir || !taskDir) {
  console.error('Usage: platform-cli.js <tasksDir> <taskDir> [mode]');
  process.exit(1);
}

// Read notify context: env (from triggering session) > plugin config (fallback)
let notifyChannel = process.env.TASKFLOW_NOTIFY_CHANNEL || '';
let notifyTarget = process.env.TASKFLOW_NOTIFY_TARGET || '';
if (!notifyChannel || !notifyTarget) {
  try {
    const config = JSON.parse(readFileSync(join(process.env.HOME, '.openclaw', 'openclaw.json'), 'utf-8'));
    const taskflowConfig = config.plugins?.entries?.taskflow?.config || {};
    notifyChannel = notifyChannel || taskflowConfig.notify?.channel || '';
    notifyTarget = notifyTarget || taskflowConfig.notify?.target || '';
  } catch (e) {}
}

function sendNotification(message, manifest) {
  if (!notifyChannel || !notifyTarget) return;

  const stats = countStats(manifest.pipeline);
  const text = [
    `🔥 **Taskflow ${stats.failed > 0 ? 'Stopped' : 'Complete'}**`,
    ``,
    `**${manifest.issue || taskDir}** — ${stats.done}/${stats.total} done, ${stats.failed} failed`,
    manifest.branch ? `Branch: \`${manifest.branch}\`` : null,
  ].filter(Boolean).join('\n');

  try {
    execSync(
      `openclaw message send --channel ${notifyChannel} --target ${JSON.stringify(notifyTarget)} --message ${JSON.stringify(text)}`,
      { encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    console.log('📨 Notification sent');
  } catch (e) {
    console.log('⚠️ Notification failed:', (e.message || '').slice(0, 150));
  }
}

runPipeline(tasksDir, taskDir, mode || 'direct', {
  onNotify: sendNotification,
  logger: console,
}).catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
