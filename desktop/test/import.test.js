const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { describe, it } = require('node:test');
const { importData } = require('../import-worker');

const sqlite3 = createRequire(path.join(__dirname, '..', '..', 'code', 'package.json'))('sqlite3');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mock-server-import-'));

function exec(db, sql) {
  return new Promise((resolve, reject) => db.exec(sql, (error) => (error ? reject(error) : resolve())));
}

function open(file) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file, (error) => (error ? reject(error) : resolve(db)));
  });
}

function close(db) {
  return new Promise((resolve) => db.close(() => resolve()));
}

async function count(file) {
  const db = await open(file);
  try {
    return await new Promise((resolve, reject) =>
      db.get('SELECT COUNT(*) AS n FROM rutas', (error, row) => (error ? reject(error) : resolve(row.n))),
    );
  } finally {
    await close(db);
  }
}

async function installation({ routes, upload, keepOpen = false }) {
  const dir = tempDir();
  const file = path.join(dir, 'database.db');
  const db = await open(file);
  await exec(db, 'PRAGMA journal_mode=WAL; CREATE TABLE rutas (id INTEGER PRIMARY KEY, ruta TEXT); CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT);');
  for (let i = 0; i < routes; i += 1) await exec(db, `INSERT INTO rutas (ruta) VALUES ('/r${i}')`);
  if (upload) {
    fs.mkdirSync(path.join(dir, 'uploads'));
    fs.writeFileSync(path.join(dir, 'uploads', upload), 'contenido');
  }
  if (!keepOpen) await close(db);
  return { dir, file, db };
}

describe('importar los datos de otra instalación', () => {
  it('se lleva las rutas y los ficheros subidos, y deja el original como estaba', async () => {
    const source = await installation({ routes: 3, upload: '123-respuesta.json' });
    const before = fs.readFileSync(source.file);
    const dataDir = tempDir();

    const result = await importData({ sqlite3, source: source.file, dataDir, backupDir: tempDir() });

    assert.deepEqual(result, { routes: 3, files: 1, previous: null });
    assert.equal(await count(path.join(dataDir, 'database.db')), 3);
    assert.equal(fs.readFileSync(path.join(dataDir, 'uploads', '123-respuesta.json'), 'utf8'), 'contenido');
    assert.deepEqual(fs.readFileSync(source.file), before);
  });

  it('incluye lo que aún está en el WAL, para poder importar desde una instalación en marcha', async () => {
    const source = await installation({ routes: 5, keepOpen: true });
    try {
      assert.ok(fs.statSync(`${source.file}-wal`).size > 0);
      const dataDir = tempDir();
      const result = await importData({ sqlite3, source: source.file, dataDir, backupDir: tempDir() });
      assert.equal(result.routes, 5);
      assert.equal(await count(path.join(dataDir, 'database.db')), 5);
    } finally {
      await close(source.db);
    }
  });

  it('aparta los datos que había, base y ficheros juntos, en vez de borrarlos', async () => {
    const current = await installation({ routes: 1, upload: 'viejo.txt' });
    const source = await installation({ routes: 2 });
    const backupDir = tempDir();

    const result = await importData({ sqlite3, source: source.file, dataDir: current.dir, backupDir });

    assert.ok(result.previous.startsWith(backupDir));
    assert.equal(await count(path.join(result.previous, 'database.db')), 1);
    assert.ok(fs.existsSync(path.join(result.previous, 'uploads', 'viejo.txt')));
    assert.equal(fs.existsSync(path.join(current.dir, 'uploads', 'viejo.txt')), false);
    assert.equal(await count(path.join(current.dir, 'database.db')), 2);
  });

  it('rechaza una base que no es de Mock Server sin tocar los datos actuales', async () => {
    const current = await installation({ routes: 4 });
    const other = path.join(tempDir(), 'otra.db');
    const db = await open(other);
    await exec(db, 'CREATE TABLE users (id INTEGER)');
    await close(db);

    await assert.rejects(
      importData({ sqlite3, source: other, dataDir: current.dir, backupDir: tempDir() }),
      /No parece una base de datos de Mock Server: le faltan las tablas rutas, tags/,
    );
    assert.equal(await count(current.file), 4);
  });

  it('se niega a importar la propia base de la aplicación sobre sí misma', async () => {
    const current = await installation({ routes: 1 });
    await assert.rejects(
      importData({ sqlite3, source: current.file, dataDir: current.dir, backupDir: tempDir() }),
      /ya es la base de datos de la aplicación/,
    );
    assert.equal(await count(current.file), 1);
  });
});
