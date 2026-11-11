const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { resolveTargets, sqliteBinding, stageDir } = require('./targets');

const DESKTOP = path.join(__dirname, '..');
const CODE = path.join(DESKTOP, '..', 'code');
const STAGE = path.join(DESKTOP, '.stage');
const SERVER_FILES = ['package.json', 'package-lock.json', 'app.js', 'middlewares', 'routes', 'services', 'views', 'public', 'locales', 'openapi'];

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
}

function stageServer(target) {
  const server = path.join(STAGE, stageDir(target.platform, target.arch), 'server');
  fs.rmSync(path.dirname(server), { recursive: true, force: true });
  fs.mkdirSync(server, { recursive: true });
  for (const entry of SERVER_FILES) {
    fs.cpSync(path.join(CODE, entry), path.join(server, entry), { recursive: true });
  }
  run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], server);
  sqliteFor(path.join(server, 'node_modules', 'sqlite3'), target);
  return server;
}

function sqliteFor(sqlite, target) {
  const preGyp = require.resolve('@mapbox/node-pre-gyp/bin/node-pre-gyp', { paths: [sqlite] });
  run(
    process.execPath,
    [preGyp, 'install', '--update-binary', `--target_platform=${target.platform}`, `--target_arch=${target.arch}`, `--target_libc=${target.libc}`],
    sqlite,
  );
  const binding = path.join(sqlite, 'lib', 'binding', sqliteBinding(target), 'node_sqlite3.node');
  if (!fs.existsSync(binding)) {
    throw new Error(`sqlite3 no ha dejado su binario para ${target.name} en ${binding}`);
  }
}

if (require.main === module) {
  for (const target of resolveTargets(process.argv.slice(2))) stageServer(target);
}

module.exports = { STAGE, stageServer };
