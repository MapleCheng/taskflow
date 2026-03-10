#!/usr/bin/env node
/**
 * Taskflow Dashboard Server
 * Reads manifest.json from task directories, serves progress API + Web UI
 * 
 * Usage: node server.js [port]
 * Default port: 3847
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.TASKFLOW_PORT || process.argv[2]) || 3847;
const TASKS_DIR = process.env.TASKFLOW_TASKS_DIR || path.join(process.env.HOME, 'clawd', 'tasks');
const DASHBOARD_HTML = path.join(__dirname, 'index.html');
const crypto = require('crypto');
const DASHBOARD_SECRET = process.env.TASKFLOW_SECRET || '';
const COOKIE_AUTH = 'taskflow_auth';
const COOKIE_DEVICE = 'taskflow_device';
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60; // 1 year
const DEVICES_FILE = path.join(__dirname, '.devices.json');

function generateToken(secret, id = '1') {
  return crypto.createHmac('sha256', secret).update(`taskflow-dashboard-${id}`).digest('hex');
}

function allValidTokens(secret) {
  const devices = loadDevices();
  // Generate tokens 1~10, return those not yet bound + already bound ones
  const tokens = [];
  for (let i = 1; i <= 10; i++) {
    tokens.push(generateToken(secret, String(i)));
  }
  return tokens;
}

function findMatchingToken(input, secret) {
  for (let i = 1; i <= 10; i++) {
    const t = generateToken(secret, String(i));
    if (input.length === t.length && crypto.timingSafeEqual(Buffer.from(input), Buffer.from(t))) return t;
  }
  return null;
}

function loadDevices() {
  try { return JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf-8')); } catch { return {}; }
}

function saveDevices(devices) {
  fs.writeFileSync(DEVICES_FILE, JSON.stringify(devices, null, 2));
}

function safeEqual(a, b) {
  return a && b && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function parseCookies(req) {
  return (req.headers.cookie || '').split(';').reduce((acc, c) => {
    const [k, v] = c.trim().split('=');
    if (k && v) acc[k] = v;
    return acc;
  }, {});
}

function setCookies(res, token, deviceId, extra) {
  const base = `Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax; Secure`;
  res.setHeader('Set-Cookie', [
    `${COOKIE_AUTH}=${token}; ${base}`,
    `${COOKIE_DEVICE}=${deviceId}; ${base}`,
  ]);
}

function checkAuth(req, res) {
  if (!DASHBOARD_SECRET) return true;

  // Block bots from triggering device binding (e.g. Discord link preview)
  const ua = req.headers['user-agent'] || '';
  if (/bot|crawler|spider|preview|embed/i.test(ua)) {
    res.writeHead(403);
    res.end('');
    return false;
  }

  const cookies = parseCookies(req);
  const devices = loadDevices();

  // ?token= takes priority — bind new device (replaces old cookie)
  const url = new URL(req.url, `http://${req.headers.host}`);
  const inputToken = url.searchParams.get('token');
  const matchedToken = inputToken ? findMatchingToken(inputToken, DASHBOARD_SECRET) : null;
  if (matchedToken) {
    if (devices[matchedToken]) {
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h2>Taskflow Dashboard</h2><p>This token is already bound to another device. Generate a new token.</p>');
      return false;
    }
    const deviceId = crypto.randomBytes(16).toString('hex');
    devices[matchedToken] = deviceId;
    saveDevices(devices);
    url.searchParams.delete('token');
    setCookies(res, matchedToken, deviceId);
    res.writeHead(302, { 'Location': url.pathname + url.search });
    res.end();
    return false;
  }

  // Returning visitor: verify auth cookie + device binding
  const cookieToken = cookies[COOKIE_AUTH] ? findMatchingToken(cookies[COOKIE_AUTH], DASHBOARD_SECRET) : null;
  if (cookieToken) {
    const deviceId = cookies[COOKIE_DEVICE];
    if (deviceId && devices[cookieToken] === deviceId) return true;
    res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h2>Taskflow Dashboard</h2><p>Invalid session. Use a new token link to bind this device.</p>');
    return false;
  }


  res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<h2>Taskflow Dashboard</h2><p>Unauthorized. Append <code>?token=YOUR_TOKEN</code> to the URL.</p>');
  return false;
}

function scanManifests() {
  const tasks = [];
  if (!fs.existsSync(TASKS_DIR)) return tasks;

  for (const dir of fs.readdirSync(TASKS_DIR)) {
    const manifestPath = path.join(TASKS_DIR, dir, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        manifest._dir = dir;
        manifest._stats = computeStats(manifest.pipeline || []);
        tasks.push(manifest);
      } catch (e) {
        tasks.push({ _dir: dir, _error: e.message });
      }
    }
  }
  tasks.sort((a, b) => {
    const ta = a.startedAt || a.createdAt || '';
    const tb = b.startedAt || b.createdAt || '';
    return tb.localeCompare(ta);
  });
  return tasks;
}

function computeStats(pipeline) {
  let total = 0, done = 0, failed = 0, running = 0, skipped = 0;

  function walk(nodes) {
    for (const node of nodes) {
      if (node.children && node.children.length > 0) {
        walk(node.children);
      } else {
        // leaf node = actual unit
        total++;
        if (node.status === 'done') done++;
        else if (node.status === 'failed') failed++;
        else if (node.status === 'running') running++;
        else if (node.status === 'skipped') skipped++;
      }
    }
  }

  walk(pipeline);
  return { total, done, failed, running, skipped, pending: total - done - failed - running - skipped };
}

const SESSIONS_DIR = path.join(process.env.HOME, '.openclaw', 'agents', 'main', 'sessions');

function findSessionTranscript(taskDir, unitId) {
  const sessionName = `taskflow-${taskDir}-${unitId}`;

  // Method 1: Direct JSONL file (openclaw agent --session-id creates these)
  let jsonlPath = path.join(SESSIONS_DIR, `${sessionName}.jsonl`);
  
  // Method 2: Look up in sessions.json store
  if (!fs.existsSync(jsonlPath)) {
    const storePath = path.join(SESSIONS_DIR, 'sessions.json');
    if (fs.existsSync(storePath)) {
      try {
        const store = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
        for (const [key, val] of Object.entries(store)) {
          if (key.includes(sessionName) && val.sessionId) {
            const altPath = path.join(SESSIONS_DIR, `${val.sessionId}.jsonl`);
            if (fs.existsSync(altPath)) { jsonlPath = altPath; break; }
          }
        }
      } catch (_) {}
    }
  }

  if (!fs.existsSync(jsonlPath)) return null;

  try {
    const lines = fs.readFileSync(jsonlPath, 'utf-8').split('\n').filter(l => l.trim());
    const messages = [];
    
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        
        // OpenClaw JSONL v3: type=message, actual content in entry.message
        if (entry.type === 'message' && entry.message) {
          const m = typeof entry.message === 'string' ? JSON.parse(entry.message) : entry.message;
          if (m.role === 'system') continue; // skip system
          
          const msg = { role: m.role, timestamp: entry.timestamp };
          const parts = [];

          if (typeof m.content === 'string') {
            parts.push(m.content);
          } else if (Array.isArray(m.content)) {
            for (const part of m.content) {
              if (part.type === 'text' && part.text) {
                parts.push(part.text);
              } else if (part.type === 'thinking' && part.thinking) {
                parts.push(`💭 Thinking:\n${part.thinking.slice(0, 500)}`);
              } else if (part.type === 'tool_use') {
                const args = JSON.stringify(part.input || {}, null, 2);
                parts.push(`🔧 ${part.name}\n${args.slice(0, 800)}`);
              } else if (part.type === 'tool_result') {
                const result = typeof part.content === 'string' 
                  ? part.content 
                  : Array.isArray(part.content) 
                    ? part.content.map(c => c.text || '').join('\n')
                    : JSON.stringify(part.content || '');
                parts.push(`📎 Result:\n${result.slice(0, 1500)}`);
              }
            }
          }

          msg.text = parts.join('\n\n');
          if (msg.text && msg.text.trim()) messages.push(msg);
        }
      } catch (_) {}
    }

    return { sessionId: sessionName, messages };
  } catch (e) {
    return { error: e.message };
  }
}

const server = http.createServer((req, res) => {
  if (!checkAuth(req, res)) return;
  const unitMatch = req.url.match(/^\/api\/unit\/([^/]+)\/(.+\.md)$/);
  const logMatch = req.url.match(/^\/api\/log\/([^/]+)\/(.+)$/);
  const sessionMatch = req.url.match(/^\/api\/session\/([^/]+)\/(.+)$/);
  if (sessionMatch) {
    // Read session transcript for a unit
    const dir = decodeURIComponent(sessionMatch[1]);
    const unitId = decodeURIComponent(sessionMatch[2]);
    const transcript = findSessionTranscript(dir, unitId);
    if (transcript) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(transcript));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No session found' }));
    }
  } else if (logMatch) {
    const dir = decodeURIComponent(logMatch[1]);
    const unitId = decodeURIComponent(logMatch[2]);
    const logPath = path.join(TASKS_DIR, dir, 'logs', `${unitId}.log`);
    if (fs.existsSync(logPath)) {
      res.writeHead(200, { 
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache'
      });
      res.end(fs.readFileSync(logPath, 'utf-8'));
    } else {
      res.writeHead(404);
      res.end('No log yet');
    }
  } else if (req.url === '/api/tasks') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(scanManifests(), null, 2));
  } else if (unitMatch) {
    const dir = decodeURIComponent(unitMatch[1]);
    const file = decodeURIComponent(unitMatch[2]);
    const unitPath = path.join(TASKS_DIR, dir, 'units', file);
    if (fs.existsSync(unitPath)) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(fs.readFileSync(unitPath, 'utf-8'));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unit file not found', path: unitPath }));
    }
  } else if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    const html = fs.readFileSync(DASHBOARD_HTML, 'utf-8')
      .replace("const ISSUE_BASE = '';", `const ISSUE_BASE = '${(process.env.TASKFLOW_ISSUE_BASE || '').replace(/'/g, "\\'")}';`);
    res.end(html);
  } else {
    // Serve static files (PWA assets)
    const STATIC_FILES = {
      '/manifest.json': { file: 'manifest.json', type: 'application/json' },
      '/sw.js': { file: 'sw.js', type: 'application/javascript' },
      '/icon-192.png': { file: 'icon-192.png', type: 'image/png' },
      '/icon-512.png': { file: 'icon-512.png', type: 'image/png' },
    };
    const s = STATIC_FILES[req.url];
    if (s) {
      const fp = path.join(__dirname, s.file);
      if (fs.existsSync(fp)) {
        res.writeHead(200, { 'Content-Type': s.type, 'Cache-Control': 'public, max-age=86400' });
        res.end(fs.readFileSync(fp));
        return;
      }
    }
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Taskflow Dashboard: http://0.0.0.0:${PORT}`);
});
