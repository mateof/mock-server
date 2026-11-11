const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const DATABASE = 'database.db';
const REQUIRED_TABLES = ['rutas', 'tags'];

function open(sqlite3, file, mode) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file, mode, (error) => (error ? reject(error) : resolve(db)));
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (error, rows) => (error ? reject(error) : resolve(rows))));
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (error) => (error ? reject(error) : resolve())));
}

function close(db) {
  return new Promise((resolve) => db.close(() => resolve()));
}

function moveAside(dataDir, backupDir) {
  const entries = [DATABASE, `${DATABASE}-wal`, `${DATABASE}-shm`, 'uploads'].filter((entry) => fs.existsSync(path.join(dataDir, entry)));
  if (!entries.includes(DATABASE)) return null;
  const previous = path.join(backupDir, `before-import-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(previous, { recursive: true });
  for (const entry of entries) fs.renameSync(path.join(dataDir, entry), path.join(previous, entry));
  return previous;
}

async function importData({ sqlite3, source, dataDir, backupDir }) {
  const target = path.join(dataDir, DATABASE);
  if (path.resolve(source) === path.resolve(target)) {
    throw new Error('Ese fichero ya es la base de datos de la aplicación');
  }
  const from = await open(sqlite3, source, sqlite3.OPEN_READONLY);
  try {
    const present = new Set((await all(from, "SELECT name FROM sqlite_master WHERE type = 'table'")).map((row) => row.name));
    const missing = REQUIRED_TABLES.filter((name) => !present.has(name));
    if (missing.length > 0) {
      throw new Error(`No parece una base de datos de Mock Server: le faltan las tablas ${missing.join(', ')}`);
    }
    const [{ n: routes }] = await all(from, 'SELECT COUNT(*) AS n FROM rutas');

    fs.mkdirSync(dataDir, { recursive: true });
    const incoming = `${target}.importing`;
    fs.rmSync(incoming, { force: true });
    await run(from, 'VACUUM INTO ?', [incoming]);

    const previous = moveAside(dataDir, backupDir);
    fs.renameSync(incoming, target);

    const uploads = path.join(path.dirname(source), 'uploads');
    let files = 0;
    if (fs.existsSync(uploads)) {
      fs.cpSync(uploads, path.join(dataDir, 'uploads'), { recursive: true });
      files = fs.readdirSync(uploads).length;
    }
    return { routes, files, previous };
  } finally {
    await close(from);
  }
}

if (process.parentPort) {
  const [serverDir, source, dataDir, backupDir] = process.argv.slice(2);
  const sqlite3 = createRequire(path.join(serverDir, 'package.json'))('sqlite3');
  importData({ sqlite3, source, dataDir, backupDir })
    .then((result) => process.parentPort.postMessage({ ok: true, result }))
    .catch((error) => process.parentPort.postMessage({ ok: false, message: error.message }))
    .finally(() => process.exit(0));
}

module.exports = { importData };
