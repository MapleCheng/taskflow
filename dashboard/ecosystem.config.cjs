const fs = require('fs');
const path = require('path');

// Read plugin config from openclaw.json
let pluginConfig = {};
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.openclaw', 'openclaw.json'), 'utf-8'));
  pluginConfig = cfg.plugins?.entries?.taskflow?.config || {};
} catch {}

module.exports = {
  apps: [{
    name: 'taskflow-dashboard',
    script: 'server.cjs',
    cwd: __dirname,
    env: {
      TASKFLOW_PORT: String(pluginConfig.dashboardPort || 3847),
      TASKFLOW_TASKS_DIR: pluginConfig.tasksDir || path.join(process.env.HOME, 'clawd', 'tasks'),
      TASKFLOW_ISSUE_BASE: pluginConfig.issueBaseUrl || '',
      TASKFLOW_SECRET: pluginConfig.dashboardSecret || '',
    },
  }],
};
