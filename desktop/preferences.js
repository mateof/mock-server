const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { LOCAL_HOST, NETWORK_HOST } = require('./network');

const FILE = 'desktop.json';
const DEFAULT_PORT = 3880;
const DEFAULTS = { exposed: false, requireKey: true, accessKey: null, port: DEFAULT_PORT };

function readPreferences(dir) {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

function writePreferences(dir, changes) {
  const merged = { ...readPreferences(dir), ...changes };
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, FILE);
  fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return merged;
}

function newAccessKey() {
  return crypto.randomBytes(24).toString('base64url');
}

function ensureAccessKey(dir) {
  const current = readPreferences(dir);
  if (current.accessKey) return current;
  return writePreferences(dir, { accessKey: newAccessKey() });
}

function preferredPort(preferences) {
  const port = Number(preferences.port);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT;
}

function networkSettings(preferences) {
  if (!preferences.exposed) return { host: LOCAL_HOST, accessKey: null };
  return { host: NETWORK_HOST, accessKey: preferences.requireKey ? preferences.accessKey : null };
}

module.exports = { DEFAULT_PORT, ensureAccessKey, networkSettings, newAccessKey, preferredPort, readPreferences, writePreferences };
