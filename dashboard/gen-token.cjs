#!/usr/bin/env node
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEVICES_FILE = path.join(__dirname, '.devices.json');
const configPath = path.join(process.env.HOME, '.openclaw', 'openclaw.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
const secret = config.plugins?.entries?.taskflow?.config?.dashboardSecret;

if (!secret) {
  console.error('No dashboardSecret found in openclaw.json');
  process.exit(1);
}

const action = process.argv[2] || 'new';

if (action === 'list') {
  const devices = fs.existsSync(DEVICES_FILE) ? JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf-8')) : {};
  console.log(`Bound devices: ${Object.keys(devices).length}`);
  for (const [token, deviceId] of Object.entries(devices)) {
    const slot = findSlot(token, secret);
    console.log(`  #${slot}: ${deviceId}`);
  }
} else if (action === 'new') {
  const devices = fs.existsSync(DEVICES_FILE) ? JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf-8')) : {};
  for (let i = 1; i <= 10; i++) {
    const t = crypto.createHmac('sha256', secret).update(`taskflow-dashboard-${i}`).digest('hex');
    if (!devices[t]) {
      console.log(`Token #${i}:`);
      console.log(t);
      return;
    }
  }
  console.error('All 10 slots are bound. Run: node gen-token.js clear');
} else if (action === 'clear') {
  fs.writeFileSync(DEVICES_FILE, '{}');
  console.log('All device bindings cleared.');
} else {
  console.log('Usage: node gen-token.js [new|list|clear]');
}

function findSlot(token, secret) {
  for (let i = 1; i <= 10; i++) {
    if (crypto.createHmac('sha256', secret).update(`taskflow-dashboard-${i}`).digest('hex') === token) return i;
  }
  return '?';
}
