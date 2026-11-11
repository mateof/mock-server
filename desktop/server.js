const fs = require('node:fs');
const path = require('node:path');
const { utilityProcess } = require('electron');
const { serverEnvironment } = require('./environment');
const { LOCAL_HOST } = require('./network');

const READY_TIMEOUT_MS = 30000;
const LOG_LIMIT_BYTES = 10 * 1024 * 1024;

async function waitUntilReady(url, child, lines) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let exited = null;
  child.once('exit', (code) => {
    exited = code;
  });
  while (Date.now() < deadline) {
    if (exited !== null) {
      throw new Error(`El servidor se ha parado al arrancar (código ${exited}).\n\n${lines.slice(-8).join('\n')}`);
    }
    try {
      const response = await fetch(`${url}/api/v1/server`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`El servidor no ha respondido en ${READY_TIMEOUT_MS / 1000} s.\n\n${lines.slice(-8).join('\n')}`);
}

function openLog(logFile) {
  try {
    if (fs.statSync(logFile).size > LOG_LIMIT_BYTES) fs.renameSync(logFile, `${logFile}.1`);
  } catch {}
  return fs.createWriteStream(logFile, { flags: 'a' });
}

async function startServer({ serverDir, dataDir, port, host, accessKey, logFile }) {
  const url = `http://localhost:${port}`;
  const lines = [];
  const log = openLog(logFile);
  const child = utilityProcess.fork(path.join(serverDir, 'app.js'), [], {
    serviceName: 'Mock Server',
    cwd: serverDir,
    stdio: 'pipe',
    env: serverEnvironment({ port, host, dataDir, accessKey }),
  });
  const capture = (chunk) => {
    log.write(chunk);
    lines.push(...String(chunk).trimEnd().split('\n'));
    lines.splice(0, Math.max(0, lines.length - 50));
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);

  try {
    await waitUntilReady(`http://${LOCAL_HOST}:${port}`, child, lines);
  } catch (error) {
    child.kill();
    log.end();
    throw error;
  }

  return {
    url,
    port,
    host,
    accessKey,
    child,
    stop: () =>
      new Promise((resolve) => {
        if (child.pid === undefined) {
          log.end();
          resolve();
          return;
        }
        const force = setTimeout(() => child.kill(), 10000);
        child.once('exit', () => {
          clearTimeout(force);
          log.end();
          resolve();
        });
        child.kill();
      }),
  };
}

function runImport({ serverDir, source, dataDir, backupDir }) {
  return new Promise((resolve, reject) => {
    const worker = utilityProcess.fork(
      path.join(__dirname.replace(/app\.asar$/, 'app.asar.unpacked'), 'import-worker.js'),
      [serverDir, source, dataDir, backupDir],
      { serviceName: 'Mock Server import' },
    );
    let answered = false;
    worker.once('message', (message) => {
      answered = true;
      if (message.ok) resolve(message.result);
      else reject(new Error(message.message));
    });
    worker.once('exit', (code) => {
      if (!answered) reject(new Error(`La importación se ha parado (código ${code})`));
    });
  });
}

module.exports = { runImport, startServer };
