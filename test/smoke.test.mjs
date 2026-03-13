import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveRuntimeSelection, buildUnitExecutor, createStopController, buildReporterPrompt } from '../src/runtime.js';
import { deriveProject, buildEndOfRunReporterPayload, flattenExecutableUnits, findNextPendingExecutableUnit, rollupPipelineStatuses, runPipeline, buildUnitPrompt, buildExtraSystemPrompt } from '../src/platform.js';

// ID naming convention (from dev skill):
//   group id  → a, b, c, d ...
//   unit id   → a1, a2, b1, b2 ...
//   nested    → a1-1, a1-2 ...
//   task id   → YYMMDDHHmmss

function createTask(tasksDir, manifest, units) {
  const taskDir = manifest.id;
  const taskPath = join(tasksDir, taskDir);
  mkdirSync(join(taskPath, 'units'), { recursive: true });
  writeFileSync(join(taskPath, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const [name, content] of Object.entries(units)) {
    writeFileSync(join(taskPath, 'units', name), content);
  }
  return taskDir;
}

// ── Runtime selection ──────────────────────────────────────────────────────

test('resolveRuntimeSelection keeps subagent as default and honors manifest/override precedence', () => {
  assert.deepEqual(resolveRuntimeSelection({}, {}, undefined), { mode: 'subagent', source: 'plugin-config' });
  assert.deepEqual(resolveRuntimeSelection({ runtime: 'subagent' }, { runtime: { mode: 'subagent', source: 'manifest.runtime' } }, undefined), { mode: 'subagent', source: 'manifest.runtime' });
  assert.deepEqual(resolveRuntimeSelection({ runtime: 'subagent' }, { runtime: { mode: 'subagent', source: 'manifest.runtime' } }, 'subagent'), { mode: 'subagent', source: 'taskflow_run' });
});

// ── Unit executor ──────────────────────────────────────────────────────────

test('subagent executor parses final JSON status', async () => {
  const api = {
    runtime: {
      subagent: {
        async run() { return { runId: 'run-sub-1' }; },
        async waitForRun() { return { status: 'done' }; },
        async getSessionMessages() {
          return {
            messages: [
              { role: 'assistant', content: 'work complete\n{"status":"done","summary":"subagent ok"}' },
            ],
          };
        },
      },
    },
  };

  const executor = buildUnitExecutor(api, { runtime: 'subagent', timeout: 5000 }, {}, {
    stopController: createStopController(),
    runtimeMode: 'subagent',
  });

  const result = await executor('taskflow-subagent-test', 'prompt');
  assert.equal(result.status, 'done');
  assert.equal(result.summary, 'subagent ok');
  assert.equal(result.runtime, 'subagent');
});

// ── Reporter prompt ────────────────────────────────────────────────────────

test('buildReporterPrompt targets the main agent session for downstream forwarding', () => {
  const payload = {
    task: { id: '260312230000', title: 'Test Pipeline', status: 'done' },
    stats: { total: 2, done: 2, failed: 0, pending: 0 },
    manifest: { session: 'test:target-session' },
  };

  const prompt = buildReporterPrompt(payload, 'original', 'test:target-session');

  assert.match(prompt, /Final status: \*\*DONE\*\*/);
  assert.match(prompt, /Write a concise human-readable summary for the target session/);
  assert.match(prompt, /Target session: test:target-session/);
});

test('buildReporterPrompt includes status-specific guidance for failed pipelines', () => {
  const payload = {
    task: { id: '260312230000', title: 'Test', status: 'failed' },
    stats: { total: 1, done: 0, failed: 1, pending: 0 },
    focusUnit: { id: 'a1', title: 'Backend', error: 'boom' },
    summary: { error: 'boom' },
    manifest: { session: 'test:target-session' },
  };

  const prompt = buildReporterPrompt(payload, 'original', 'test:target-session');

  assert.match(prompt, /Final status: \*\*FAILED\*\*/);
  assert.match(prompt, /Explain what failed/);
});

test('buildReporterPrompt includes status-specific guidance for stopped pipelines', () => {
  const payload = {
    task: { id: '260312230000', title: 'Test', status: 'stopped' },
    stats: { total: 2, done: 1, failed: 0, pending: 1 },
    manifest: { session: 'test:target-session' },
  };

  const prompt = buildReporterPrompt(payload, 'original', 'test:target-session');

  assert.match(prompt, /Final status: \*\*STOPPED\*\*/);
  assert.match(prompt, /Explain why the pipeline was stopped/);
});

// ── Pipeline execution ─────────────────────────────────────────────────────

test('runPipeline marks failed pipelines as failed instead of stopped', async () => {
  const tasksDir = mkdtempSync(join(tmpdir(), 'taskflow-test-'));
  const manifest = {
    id: '260312000001',
    title: 'Failure propagation',
    session: 'test:target-session',
    status: 'pending',
    createdAt: new Date().toISOString(),
    pipeline: [
      {
        id: 'a',
        title: 'Setup',
        status: 'pending',
        children: [
          { id: 'a1', title: 'Init', unit: 'a1.md', status: 'pending' },
        ],
      },
    ],
  };
  createTask(tasksDir, manifest, { 'a1.md': 'do something' });

  await runPipeline(tasksDir, manifest.id, {
    executor: async () => ({ status: 'failed', error: 'boom' }),
    runtimeSelection: { mode: 'subagent', source: 'plugin-config' },
  });

  const final = JSON.parse(readFileSync(join(tasksDir, manifest.id, 'manifest.json'), 'utf8'));
  assert.equal(final.status, 'failed');
  assert.equal(final.pipeline[0].children[0].status, 'failed');
  assert.equal(final.currentUnitId, 'a1');
  assert.deepEqual(final.currentUnitPath, ['a', 'a1']);
  assert.equal(final.failedUnitId, 'a1');
  assert.deepEqual(final.failedUnitPath, ['a', 'a1']);
  assert.equal(final.lastError, 'boom');
});

test('runPipeline converts running/pending units to cancelled after panic stop', async () => {
  const tasksDir = mkdtempSync(join(tmpdir(), 'taskflow-test-stop-'));
  const manifest = {
    id: '260312000002',
    title: 'Stop propagation',
    session: 'test:target-session',
    status: 'pending',
    createdAt: new Date().toISOString(),
    stopReason: 'operator stop',
    pipeline: [
      {
        id: 'a',
        title: 'Backend',
        status: 'pending',
        children: [
          { id: 'a1', title: 'Step 1', unit: 'a1.md', status: 'pending' },
          { id: 'a2', title: 'Step 2', unit: 'a2.md', status: 'pending' },
        ],
      },
    ],
  };
  createTask(tasksDir, manifest, { 'a1.md': 'step 1', 'a2.md': 'step 2' });

  let shouldStop = false;
  await runPipeline(tasksDir, manifest.id, {
    executor: async () => {
      shouldStop = true;
      return { status: 'failed', error: 'operator stop' };
    },
    shouldStop: () => shouldStop,
    runtimeSelection: { mode: 'subagent', source: 'plugin-config' },
  });

  const final = JSON.parse(readFileSync(join(tasksDir, manifest.id, 'manifest.json'), 'utf8'));
  assert.equal(final.status, 'stopped');
  assert.equal(final.pipeline[0].children[0].status, 'cancelled');
  assert.equal(final.pipeline[0].children[1].status, 'cancelled');
  assert.equal(final.currentUnitId, 'a1');
  assert.deepEqual(final.currentUnitPath, ['a', 'a1']);
  assert.equal(final.failedUnitId, 'a1');
  assert.deepEqual(final.failedUnitPath, ['a', 'a1']);
  assert.equal(final.lastError, 'operator stop');
});

test('runPipeline exposes nested failed unit location in manifest state and logs', async () => {
  const tasksDir = mkdtempSync(join(tmpdir(), 'taskflow-test-nested-fail-'));
  const manifest = {
    id: '260312000003',
    title: 'Nested failure location',
    session: 'test:target-session',
    status: 'pending',
    createdAt: new Date().toISOString(),
    pipeline: [
      {
        id: 'a',
        title: 'Backend',
        status: 'pending',
        children: [
          {
            id: 'a1',
            title: 'Core',
            status: 'pending',
            children: [
              { id: 'a1-1', title: 'Impl', unit: 'a1-1.md', status: 'pending' },
            ],
          },
        ],
      },
    ],
  };
  createTask(tasksDir, manifest, { 'a1-1.md': 'do nested work' });

  const messages = [];
  await runPipeline(tasksDir, manifest.id, {
    executor: async () => ({ status: 'failed', error: 'nested boom' }),
    runtimeSelection: { mode: 'subagent', source: 'plugin-config' },
    logger: { info: (msg) => messages.push(msg) },
  });

  const final = JSON.parse(readFileSync(join(tasksDir, manifest.id, 'manifest.json'), 'utf8'));
  assert.equal(final.status, 'failed');
  assert.equal(final.currentUnitId, 'a1-1');
  assert.deepEqual(final.currentUnitPath, ['a', 'a1', 'a1-1']);
  assert.equal(final.failedUnitId, 'a1-1');
  assert.deepEqual(final.failedUnitPath, ['a', 'a1', 'a1-1']);
  assert.equal(final.lastError, 'nested boom');
  assert.match(messages.find(m => m.includes('Running:')), /a > a1 > a1-1/);
  assert.match(messages.find(m => m.includes('Failed:')), /a > a1 > a1-1/);
});

test('runPipeline clears transient current/failed unit state after successful completion', async () => {
  const tasksDir = mkdtempSync(join(tmpdir(), 'taskflow-test-success-state-'));
  const manifest = {
    id: '260312000004',
    title: 'Success state cleanup',
    session: 'test:target-session',
    status: 'pending',
    createdAt: new Date().toISOString(),
    pipeline: [
      {
        id: 'a',
        title: 'Setup',
        status: 'pending',
        children: [
          { id: 'a1', title: 'Init', unit: 'a1.md', status: 'pending' },
        ],
      },
    ],
  };
  createTask(tasksDir, manifest, { 'a1.md': 'do work' });

  await runPipeline(tasksDir, manifest.id, {
    executor: async () => ({ status: 'done', summary: 'ok' }),
    runtimeSelection: { mode: 'subagent', source: 'plugin-config' },
  });

  const final = JSON.parse(readFileSync(join(tasksDir, manifest.id, 'manifest.json'), 'utf8'));
  assert.equal(final.status, 'done');
  assert.equal(final.currentUnitId, undefined);
  assert.equal(final.currentUnitPath, undefined);
  assert.equal(final.failedUnitId, undefined);
  assert.equal(final.failedUnitPath, undefined);
  assert.equal(final.lastError, undefined);
});

// ── onNotify / reporter payload ────────────────────────────────────────────

test('runPipeline calls onNotify with reporter payload on end-of-run', async () => {
  const tasksDir = mkdtempSync(join(tmpdir(), 'taskflow-test-notify-'));
  const manifest = {
    id: '260312000005',
    title: 'Notify payload',
    session: 'test:target-session',
    status: 'pending',
    createdAt: new Date().toISOString(),
    pipeline: [
      {
        id: 'a',
        title: 'Work',
        status: 'pending',
        children: [
          { id: 'a1', title: 'Do it', unit: 'a1.md', status: 'pending' },
        ],
      },
    ],
  };
  createTask(tasksDir, manifest, { 'a1.md': 'work' });

  const notifications = [];
  await runPipeline(tasksDir, manifest.id, {
    executor: async () => ({ status: 'failed', error: 'notify boom' }),
    runtimeSelection: { mode: 'subagent', source: 'plugin-config' },
    dashboardUrl: 'http://localhost:3847',
    onNotify: (finalManifest, payload) => {
      notifications.push({ finalManifest, payload });
    },
  });

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].payload.taskId, '260312000005');
  assert.equal(notifications[0].payload.status, 'failed');

  const final = JSON.parse(readFileSync(join(tasksDir, manifest.id, 'manifest.json'), 'utf8'));
  assert.equal(final.status, 'failed');
});

test('runPipeline does not write reporter trace when onNotify is not provided', async () => {
  const tasksDir = mkdtempSync(join(tmpdir(), 'taskflow-test-no-notify-'));
  const manifest = {
    id: '260312000006',
    title: 'No notify',
    session: 'test:target-session',
    status: 'pending',
    createdAt: new Date().toISOString(),
    pipeline: [
      {
        id: 'a',
        title: 'Work',
        status: 'pending',
        children: [
          { id: 'a1', title: 'Do it', unit: 'a1.md', status: 'pending' },
        ],
      },
    ],
  };
  createTask(tasksDir, manifest, { 'a1.md': 'work' });

  await runPipeline(tasksDir, manifest.id, {
    executor: async () => ({ status: 'done', summary: 'ok' }),
    runtimeSelection: { mode: 'subagent', source: 'plugin-config' },
  });

  const final = JSON.parse(readFileSync(join(tasksDir, manifest.id, 'manifest.json'), 'utf8'));
  assert.equal(final.status, 'done');
  assert.equal(final.run?.reporter, undefined);
});

// ── buildEndOfRunReporterPayload ───────────────────────────────────────────

test('buildEndOfRunReporterPayload includes done/failed/stopped summaries', () => {
  const donePayload = buildEndOfRunReporterPayload({
    id: '260312000010',
    title: 'Done task',
    session: 'test:target-session',
    status: 'done',
    startedAt: '2026-03-12T10:00:00.000Z',
    completedAt: '2026-03-12T10:01:30.000Z',
    run: {
      runtime: { mode: 'subagent', source: 'plugin-config' },
      startedAt: '2026-03-12T10:00:00.000Z',
      completedAt: '2026-03-12T10:01:30.000Z',
    },
    pipeline: [
      {
        id: 'a',
        title: 'Backend',
        status: 'done',
        children: [
          { id: 'a1', title: 'Impl', unit: 'a1.md', status: 'done', note: 'implemented reporter' },
          { id: 'a2', title: 'Verify', unit: 'a2.md', status: 'done' },
        ],
      },
    ],
  }, { dashboardUrl: 'http://localhost:3847' });
  assert.equal(donePayload.task.status, 'done');
  assert.equal(donePayload.runtime.durationMs, 90000);
  assert.equal(donePayload.focusUnit.id, 'a1');
  assert.equal(donePayload.summary.unit, 'implemented reporter');
  assert.equal(donePayload.manifest.dashboard, 'http://localhost:3847');

  const failedPayload = buildEndOfRunReporterPayload({
    id: '260312000011',
    title: 'Failed task',
    session: 'test:target-session',
    status: 'failed',
    startedAt: '2026-03-12T11:00:00.000Z',
    completedAt: '2026-03-12T11:00:10.000Z',
    failedUnitId: 'a2',
    failedUnitPath: ['a', 'a2'],
    lastError: 'boom',
    run: {
      runtime: { mode: 'subagent', source: 'manifest.runtime' },
      startedAt: '2026-03-12T11:00:00.000Z',
      completedAt: '2026-03-12T11:00:10.000Z',
    },
    pipeline: [
      {
        id: 'a',
        title: 'Backend',
        status: 'failed',
        children: [
          { id: 'a1', title: 'Setup', unit: 'a1.md', status: 'done', note: 'completed setup' },
          { id: 'a2', title: 'Impl', unit: 'a2.md', status: 'failed', error: 'boom' },
        ],
      },
    ],
  });
  assert.equal(failedPayload.task.status, 'failed');
  assert.equal(failedPayload.focusUnit.id, 'a2');
  assert.equal(failedPayload.summary.error, 'boom');

  const stoppedPayload = buildEndOfRunReporterPayload({
    id: '260312000012',
    title: 'Stopped task',
    session: 'test:target-session',
    status: 'stopped',
    startedAt: '2026-03-12T12:00:00.000Z',
    completedAt: '2026-03-12T12:00:05.000Z',
    currentUnitId: 'b1',
    currentUnitPath: ['b', 'b1'],
    stopReason: 'operator stop',
    run: {
      runtime: { mode: 'subagent', source: 'taskflow_run' },
      startedAt: '2026-03-12T12:00:00.000Z',
      completedAt: '2026-03-12T12:00:05.000Z',
    },
    pipeline: [
      {
        id: 'b',
        title: 'Frontend',
        status: 'cancelled',
        children: [
          { id: 'b1', title: 'UI', unit: 'b1.md', status: 'cancelled', error: 'operator stop' },
        ],
      },
    ],
  });
  assert.equal(stoppedPayload.task.status, 'stopped');
  assert.equal(stoppedPayload.focusUnit.id, 'b1');
  assert.equal(stoppedPayload.summary.error, 'operator stop');
});

// ── Tree traversal ─────────────────────────────────────────────────────────

test('flattenExecutableUnits preserves manifest order across groups and nested units', () => {
  const pipeline = [
    {
      id: 'a',
      title: 'Backend',
      status: 'pending',
      systemPrompt: 'group prompt',
      children: [
        { id: 'a1', title: 'Done unit', unit: 'a1.md', status: 'done' },
        {
          id: 'a2',
          title: 'Nested container',
          status: 'pending',
          systemPrompt: 'container prompt',
          children: [
            { id: 'a2-1', title: 'Sub step 1', unit: 'a2-1.md', status: 'pending' },
            { id: 'a2-2', title: 'Sub step 2', unit: 'a2-2.md', status: 'pending' },
          ],
        },
      ],
    },
    {
      id: 'b',
      title: 'Frontend',
      status: 'pending',
      children: [
        { id: 'b1', title: 'UI', unit: 'b1.md', status: 'pending' },
      ],
    },
  ];

  const flattened = flattenExecutableUnits(pipeline);
  assert.deepEqual(flattened.map(e => e.unit.id), ['a1', 'a2-1', 'a2-2', 'b1']);
  assert.deepEqual(flattened[1].path, ['a', 'a2', 'a2-1']);
  assert.deepEqual(flattened[1].systemPromptLayers, ['group prompt', 'container prompt']);
});

test('findNextPendingExecutableUnit selects next pending leaf from ordered flattened list', () => {
  const pipeline = [
    {
      id: 'a',
      title: 'Backend',
      status: 'pending',
      children: [
        { id: 'a1', title: 'Done', unit: 'a1.md', status: 'done' },
        {
          id: 'a2',
          title: 'Nested',
          status: 'pending',
          children: [
            { id: 'a2-1', title: 'Step 1', unit: 'a2-1.md', status: 'pending' },
            { id: 'a2-2', title: 'Step 2', unit: 'a2-2.md', status: 'pending' },
          ],
        },
      ],
    },
  ];

  const next = findNextPendingExecutableUnit(pipeline);
  assert.equal(next.unit.id, 'a2-1');
  assert.deepEqual(next.path, ['a', 'a2', 'a2-1']);
});

// ── Prompt building ────────────────────────────────────────────────────────

test('buildUnitPrompt assembles prompt without context wrapper', () => {
  const unit = { id: 'a1', title: 'Impl', unit: 'a1.md' };
  const unitContent = '# Unit: Impl\n\nDo the work.';
  const manifest = {
    id: '260312000000',
    issues: [{ url: 'https://gitea/x/y/issues/1', repo: 'x/y', number: 1, path: '/tmp/repo' }],
  };

  const prompt = buildUnitPrompt(unit, unitContent, manifest);

  assert.match(prompt, /Working directory: \/tmp\/repo/);
  assert.match(prompt, /# Unit: Impl/);
  assert.match(prompt, /Do the work/);
  assert.doesNotMatch(prompt, /\n\nThis project uses/);
  assert.doesNotMatch(prompt, /context/i);
});

test('buildExtraSystemPrompt layers systemPrompts correctly without context', () => {
  const unit = { id: 'b1', title: 'UI', unit: 'b1.md' };
  const manifest = {
    pipeline: [{
      id: 'b',
      title: 'Frontend',
      systemPrompt: 'group rules',
      children: [unit],
    }],
    systemPrompt: 'pipeline rules',
  };

  const extraSystemPrompt = buildExtraSystemPrompt(unit, manifest, {
    pluginSystemPrompt: 'plugin rules',
  });

  assert.match(extraSystemPrompt, /You are executing a taskflow unit/);
  assert.match(extraSystemPrompt, /JSON status/);
  assert.match(extraSystemPrompt, /plugin rules/);
  assert.match(extraSystemPrompt, /pipeline rules/);
  assert.match(extraSystemPrompt, /group rules/);
  assert.doesNotMatch(extraSystemPrompt, /context/i);
});

test('buildExtraSystemPrompt works with nested container systemPrompts', () => {
  const unit = { id: 'a1-1', title: 'Nested impl', unit: 'a1-1.md' };
  const manifest = {
    pipeline: [{
      id: 'a',
      title: 'Backend',
      systemPrompt: 'group prompt',
      children: [{
        id: 'a1',
        title: 'Core',
        systemPrompt: 'container prompt',
        children: [unit],
      }],
    }],
  };

  const flattened = flattenExecutableUnits(manifest.pipeline);
  const executableUnit = flattened.find(e => e.unit.id === 'a1-1');

  const extraSystemPrompt = buildExtraSystemPrompt(unit, manifest, {
    pluginSystemPrompt: 'plugin prompt',
    executableUnit,
  });

  assert.match(extraSystemPrompt, /plugin prompt/);
  assert.match(extraSystemPrompt, /group prompt/);
  assert.match(extraSystemPrompt, /container prompt/);
  const pluginIdx = extraSystemPrompt.indexOf('plugin prompt');
  const groupIdx = extraSystemPrompt.indexOf('group prompt');
  const containerIdx = extraSystemPrompt.indexOf('container prompt');
  assert.ok(pluginIdx < groupIdx && groupIdx < containerIdx, 'systemPrompts layered in correct order');
});

test('buildUnitPrompt does not include context field from manifest', () => {
  const unit = { id: 'a1', title: 'Impl', unit: 'a1.md' };
  const unitContent = 'Do something';
  const manifest = {
    issues: [{ url: 'https://gitea/x/y/issues/1', repo: 'x/y', number: 1, path: '/test/path' }],
    context: 'This should not appear',
  };

  const prompt = buildUnitPrompt(unit, unitContent, manifest);
  assert.doesNotMatch(prompt, /This should not appear/);
  assert.doesNotMatch(prompt, /context/i);
});

// ── Status rollup ──────────────────────────────────────────────────────────

test('rollupPipelineStatuses keeps group status derived from nested children', () => {
  const manifest = {
    id: '260312000020',
    title: 'Rollup',
    session: 'test:target-session',
    status: 'pending',
    createdAt: new Date().toISOString(),
    pipeline: [
      {
        id: 'a',
        title: 'Backend',
        status: 'pending',
        children: [
          {
            id: 'a1',
            title: 'Core',
            status: 'pending',
            children: [
              { id: 'a1-1', title: 'Step 1', unit: 'a1-1.md', status: 'done', completedAt: '2026-03-12T10:00:00.000Z' },
              { id: 'a1-2', title: 'Step 2', unit: 'a1-2.md', status: 'failed' },
            ],
          },
        ],
      },
      {
        id: 'b',
        title: 'Frontend',
        status: 'pending',
        children: [
          { id: 'b1', title: 'UI', unit: 'b1.md', status: 'done', completedAt: '2026-03-12T11:00:00.000Z' },
        ],
      },
    ],
  };

  rollupPipelineStatuses(manifest);

  assert.equal(manifest.pipeline[0].children[0].status, 'failed');
  assert.equal(manifest.pipeline[0].status, 'failed');
  assert.equal(manifest.pipeline[1].status, 'done');
  assert.equal(manifest.pipeline[1].completedAt, '2026-03-12T11:00:00.000Z');
});

// ── deriveProject (batch queue) ────────────────────────────────────────────

test('deriveProject returns single path', () => {
  assert.equal(deriveProject({ issues: [{ path: '/repo/backend', url: 'x', repo: 'x', number: 1 }] }), '/repo/backend');
});

test('deriveProject joins multiple paths sorted', () => {
  const manifest = {
    issues: [
      { path: '/repo/my-frontend', url: 'x', repo: 'x', number: 1 },
      { path: '/repo/my-backend', url: 'y', repo: 'y', number: 2 },
    ]
  };
  // Sorted: my-backend < my-frontend
  assert.equal(deriveProject(manifest), '/repo/my-backend|/repo/my-frontend');
});

test('deriveProject returns null for manifest without issues', () => {
  assert.equal(deriveProject({}), null);
  assert.equal(deriveProject({ issues: [] }), null);
});

test('deriveProject is order-independent', () => {
  const a = { issues: [{ path: '/a', url: 'x', repo: 'x', number: 1 }, { path: '/b', url: 'y', repo: 'y', number: 2 }] };
  const b = { issues: [{ path: '/b', url: 'y', repo: 'y', number: 2 }, { path: '/a', url: 'x', repo: 'x', number: 1 }] };
  assert.equal(deriveProject(a), deriveProject(b));
});
