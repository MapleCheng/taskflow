/**
 * Runtime adapters for taskflow unit execution.
 *
 * Taskflow currently supports subagent execution only.
 */

import { writeManifest } from './platform.js';

function safeKeys(obj) {
  if (!obj || typeof obj !== 'object') return [];
  try { return Object.keys(obj); } catch { return []; }
}

function pick(obj, paths) {
  for (const path of paths) {
    let cur = obj;
    let ok = true;
    for (const part of path.split('.')) {
      if (cur == null || !(part in cur)) { ok = false; break; }
      cur = cur[part];
    }
    if (ok && cur != null) return cur;
  }
  return undefined;
}

function getFn(root, candidates) {
  for (const name of candidates) {
    const value = root?.[name];
    if (typeof value === 'function') return value.bind(root);
  }
  return null;
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part;
      if (part?.text) return String(part.text);
      if (part?.content) return extractText(part.content);
      return '';
    }).filter(Boolean).join('\n');
  }
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.content === 'string') return content.content;
  }
  return content == null ? '' : JSON.stringify(content);
}

export function parseJsonStatus(text) {
  const lines = String(text || '').trim().split('\n').map(s => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 8); i--) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && (parsed.status === 'done' || parsed.status === 'failed')) return parsed;
    } catch {}
  }
  return null;
}

function summarizeText(text) {
  const cleaned = String(text || '').trim();
  if (!cleaned) return '';
  const lastLine = cleaned.split('\n').map(s => s.trim()).filter(Boolean).pop() || cleaned;
  return lastLine.slice(0, 240);
}

function lastAssistantText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] || {};
    if (msg.role === 'assistant' || msg.type === 'assistant') {
      const text = extractText(msg.content ?? msg.text ?? msg.message).trim();
      if (text) return text;
    }
  }
  return '';
}

async function callBackend(fn, args) {
  if (!fn) throw new Error('runtime method not available');
  return await fn(args);
}

async function collectMessages(getMessages, sessionKey, limit = 20) {
  if (!getMessages) return [];
  const result = await callBackend(getMessages, { sessionKey, limit });
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.messages)) return result.messages;
  if (Array.isArray(result?.items)) return result.items;
  return [];
}

export function buildReporterPrompt(payload, originalMessage, targetSession) {
  const status = payload?.task?.status || 'unknown';
  const statusGuidance = {
    done: 'Emphasize what was accomplished. Include unit count and any notable outcomes.',
    failed: 'Explain what failed, which unit failed, and the error. Be specific about what needs attention.',
    stopped: 'Explain why the pipeline was stopped and what progress was made before stopping.',
  }[status] || 'Describe the outcome clearly.';

  return [
    'You are the taskflow end-of-run reporter.',
    'Write a concise human-readable summary for the target session.',
    '',
    `Final status: **${status.toUpperCase()}**`,
    statusGuidance,
    '',
    'Include in your summary:',
    '- Pipeline title and ID',
    '- Unit statistics (done/total)',
    '- If failed: which unit failed and the error',
    '- If stopped: the stop reason',
    '- Dashboard link if available',
    '',
    'Use plain text only. Do not return JSON or code fences.',
    'Keep it under 200 words.',
    '',
    `Target session: ${targetSession}`,
    '',
    'Payload:',
    JSON.stringify({
      task: payload?.task,
      stats: payload?.stats,
      runtime: payload?.runtime,
      focusUnit: payload?.focusUnit,
      summary: payload?.summary,
      manifest: payload?.manifest,
    }, null, 2),
  ].join('\n');
}

function buildReporterTrace(manifest, updates) {
  return {
    runtime: 'subagent',
    finalStatus: manifest.status,
    attemptedAt: manifest.run?.reporter?.attemptedAt || null,
    completedAt: null,
    ...manifest.run?.reporter,
    ...updates,
  };
}

function resolveDeliveryTargets(api) {
  const runtime = api?.runtime || {};
  return [
    { name: 'runtime.sessions_send', fn: getFn(runtime, ['sessions_send', 'sessionsSend']) },
    { name: 'runtime.sessions.send', fn: getFn(runtime.sessions, ['send', 'sessions_send', 'sessionsSend']) },
    { name: 'runtime.a2a.send', fn: getFn(runtime.a2a, ['send', 'sessions_send', 'sessionsSend']) },
    { name: 'runtime.session.send', fn: getFn(runtime.session, ['send', 'sessions_send', 'sessionsSend']) },
  ];
}

async function deliverReporterSummary(api, targetSession, message, payload) {
  const attempts = [
    { sessionKey: targetSession, message, payload },
    { session: targetSession, message, payload },
    { targetSession, message, payload },
    { sessionKey: targetSession, content: message, payload },
    { session: targetSession, content: message, payload },
  ];

  for (const target of resolveDeliveryTargets(api)) {
    if (!target.fn) continue;
    for (const args of attempts) {
      try {
        await target.fn(args);
        return { deliveryMethod: target.name };
      } catch {}
    }
  }

  throw new Error('no supported reporter delivery method (sessions_send unavailable)');
}

export async function runEndOfRunReporter(api, tasksDir, taskDir, manifest, payload, originalMessage, { logger } = {}) {
  const log = logger || console;
  if (!payload || !manifest || !['done', 'failed', 'stopped'].includes(manifest.status)) {
    return { skipped: true, reason: 'non-terminal manifest' };
  }

  const targetSession = payload?.targetSession || payload?.manifest?.session;
  if (!targetSession) {
    const reporter = buildReporterTrace(manifest, {
      status: 'failed',
      attemptedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      error: 'target session missing',
    });
    manifest.run = { ...(manifest.run || {}), reporter };
    writeManifest(tasksDir, taskDir, manifest);
    return { status: 'failed', error: reporter.error };
  }

  if (manifest.run?.reporter?.status === 'sent' && manifest.run.reporter.finalStatus === manifest.status) {
    return { skipped: true, status: 'sent' };
  }

  const runtime = api?.runtime?.subagent;
  const attemptedAt = new Date().toISOString();
  const reporterSessionKey = `taskflow-${taskDir}-reporter`;
  manifest.run = {
    ...(manifest.run || {}),
    reporter: buildReporterTrace(manifest, {
      status: 'running',
      attemptedAt,
      completedAt: null,
      targetSession,
      reporterSessionKey,
      reporterRunId: undefined,
      deliveryMethod: undefined,
      error: null,
    }),
  };
  writeManifest(tasksDir, taskDir, manifest);

  try {
    if (!runtime) throw new Error('subagent runtime unavailable');

    const { runId } = await runtime.run({
      sessionKey: reporterSessionKey,
      message: buildReporterPrompt(payload, originalMessage, targetSession),
      lane: 'main',
      idempotencyKey: `taskflow-reporter-${taskDir}-${manifest.status}`,
    });

    manifest.run.reporter = buildReporterTrace(manifest, {
      ...manifest.run.reporter,
      reporterRunId: runId,
    });
    writeManifest(tasksDir, taskDir, manifest);

    const waitResult = await runtime.waitForRun({ runId, timeoutMs: 120000 });
    if (waitResult?.status === 'timeout') throw new Error('reporter timed out');
    if (waitResult?.status === 'error') throw new Error(waitResult.error || 'reporter failed');

    const messages = await collectMessages(runtime.getSessionMessages?.bind(runtime), reporterSessionKey, 12);
    const summary = lastAssistantText(messages) || summarizeText(originalMessage) || `Task ${manifest.status}`;
    const deliveryPayload = {
      ...payload,
      targetSession,
      originalMessage,
      reporterSummary: summary,
    };
    const delivery = await deliverReporterSummary(api, targetSession, summary, deliveryPayload);

    manifest.run.reporter = buildReporterTrace(manifest, {
      ...manifest.run.reporter,
      status: 'sent',
      completedAt: new Date().toISOString(),
      targetSession,
      reporterSessionKey,
      reporterRunId: runId,
      deliveryMethod: delivery.deliveryMethod,
      error: null,
    });
    writeManifest(tasksDir, taskDir, manifest);
    return { status: 'sent', reporterSessionKey, reporterRunId: runId, deliveryMethod: delivery.deliveryMethod, summary };
  } catch (error) {
    const message = (error && error.message) || String(error);
    manifest.run.reporter = buildReporterTrace(manifest, {
      ...manifest.run.reporter,
      status: 'failed',
      completedAt: new Date().toISOString(),
      targetSession,
      reporterSessionKey,
      error: message,
    });
    writeManifest(tasksDir, taskDir, manifest);
    log.warn?.(`taskflow: reporter failed: ${message}`);
    return { status: 'failed', error: message, reporterSessionKey };
  }
}

function deriveStatusFromMessages(messages) {
  let lastAssistantText = '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] || {};
    if (msg.role === 'assistant' || msg.type === 'assistant') {
      const text = extractText(msg.content ?? msg.text ?? msg.message);
      if (!lastAssistantText) lastAssistantText = text;
      const parsed = parseJsonStatus(text);
      if (parsed) return parsed;
    }
  }
  if (lastAssistantText.trim()) {
    return { status: 'done', summary: summarizeText(lastAssistantText) || 'Agent completed (no explicit status)' };
  }
  return null;
}

function extractEventText(event) {
  return extractText(
    event?.text
    ?? event?.message?.content
    ?? event?.message
    ?? event?.delta?.text
    ?? event?.content
    ?? event?.output_text
    ?? event?.data?.text
  );
}

function eventFinished(event) {
  return Boolean(
    event?.done
    || event?.final
    || event?.status === 'completed'
    || event?.status === 'done'
    || event?.type === 'completed'
    || event?.type === 'done'
    || event?.event === 'completed'
    || event?.event === 'done'
  );
}

function eventFailed(event) {
  const status = event?.status || event?.type || event?.event;
  return status === 'failed' || status === 'error' || status === 'cancelled' || status === 'canceled';
}

function eventErrorText(event) {
  return extractText(event?.error ?? event?.message ?? event?.data?.error ?? event?.data?.message) || 'Agent error';
}

function now() { return Date.now(); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

export function createStopController() {
  return {
    requested: false,
    reason: null,
    runId: null,
    sessionKey: null,
    runtime: null,
  };
}

export async function stopUnit(api, state, logger = console) {
  state.requested = true;
  const runtime = state.runtime;
  if (!runtime) return { stopped: false, reason: 'no active runtime' };

  const errors = [];
  const tryStop = async (scope, methods, payloads) => {
    if (!scope) return false;
    for (const name of methods) {
      const fn = typeof scope[name] === 'function' ? scope[name].bind(scope) : null;
      if (!fn) continue;
      for (const payload of payloads) {
        try {
          await fn(payload);
          logger.info?.(`taskflow: stop via ${name}`);
          return true;
        } catch (e) {
          errors.push(`${name}: ${(e && e.message) || e}`);
        }
      }
    }
    return false;
  };

  const runPayloads = state.runId ? [{ runId: state.runId }, { id: state.runId }] : [];
  const sessionPayloads = state.sessionKey ? [{ sessionKey: state.sessionKey }, { id: state.sessionKey }] : [];

  const stopped = await tryStop(runtime, ['cancelRun', 'stopRun', 'abortRun', 'killRun'], runPayloads)
    || await tryStop(runtime, ['cancelSession', 'stopSession', 'abortSession', 'terminateSession', 'closeSession'], sessionPayloads)
    || await tryStop(runtime, ['cancel', 'stop', 'abort', 'terminate', 'close'], [...runPayloads, ...sessionPayloads]);

  return {
    stopped,
    reason: stopped ? undefined : (errors[0] || 'no supported stop method'),
    errors: errors.length ? errors : undefined,
  };
}

export function resolveRuntimeSelection(config, manifest, overrideMode) {
  if (overrideMode) return { mode: overrideMode, source: 'taskflow_run' };
  if (manifest?.runtime?.mode) return { mode: manifest.runtime.mode, source: manifest.runtime.source || 'manifest.runtime' };
  if (manifest?.agent?.runtime) return { mode: manifest.agent.runtime, source: 'manifest.agent.runtime' };
  return { mode: config?.runtime || 'subagent', source: 'plugin-config' };
}

export function buildUnitExecutor(api, config, manifest, { stopController, runtimeMode } = {}) {
  const selection = resolveRuntimeSelection(config, manifest, runtimeMode);
  const mode = selection.mode;
  return buildSubagentExecutor(api, config, manifest, { stopController, runtimeMode: mode });
}

function resolveModel(config, manifest) {
  const rawModel = manifest?.agent?.model ?? config?.model ?? undefined;
  const aliases = { sonnet: 'anthropic/claude-sonnet-4-6', opus: 'anthropic/claude-opus-4-6' };
  return rawModel ? (aliases[rawModel] || rawModel) : undefined;
}

function resolveTimeout(config, manifest) {
  return manifest?.agent?.timeout ?? config?.timeout ?? 300000;
}

function resolveAgentId(config, manifest) {
  return manifest?.agent?.id ?? config?.agent ?? 'main';
}

function normalizeResult(parsed, sessionKey) {
  return {
    status: parsed.status,
    ...(parsed.summary ? { summary: parsed.summary } : {}),
    ...(parsed.error ? { error: parsed.error } : {}),
    sessionKey,
  };
}

function buildSubagentExecutor(api, config, manifest, { stopController, runtimeMode = 'subagent' } = {}) {
  const unitTimeout = resolveTimeout(config, manifest);
  const agentId = resolveAgentId(config, manifest);
  const modelOverride = resolveModel(config, manifest);

  return async (sessionKey, prompt, extraSystemPrompt) => {
    const runtime = api.runtime.subagent;
    stopController.runtime = runtime;
    stopController.sessionKey = sessionKey;

    const { runId } = await runtime.run({
      sessionKey,
      message: prompt,
      ...(extraSystemPrompt ? { extraSystemPrompt } : {}),
      lane: agentId !== 'main' ? agentId : undefined,
      ...(modelOverride ? { model: modelOverride } : {}),
      idempotencyKey: `taskflow-${sessionKey}-${Date.now()}`,
    });
    stopController.runId = runId;

    const waitResult = await runtime.waitForRun({ runId, timeoutMs: unitTimeout });

    if (stopController.requested) {
      return { status: 'failed', error: stopController.reason || 'Pipeline stopped', sessionKey, runtime: runtimeMode };
    }
    if (waitResult.status === 'timeout') {
      return { status: 'failed', error: `Unit timed out after ${unitTimeout}ms`, sessionKey, runtime: runtimeMode };
    }
    if (waitResult.status === 'error') {
      return { status: 'failed', error: waitResult.error || 'Agent error', sessionKey, runtime: runtimeMode };
    }

    const messages = await collectMessages(runtime.getSessionMessages?.bind(runtime), sessionKey, 12);
    const parsed = deriveStatusFromMessages(messages);
    if (parsed) return { ...normalizeResult(parsed, sessionKey), runtime: runtimeMode };
    return { status: 'failed', error: 'Agent completed without any assistant output', sessionKey, runtime: runtimeMode };
  };
}
