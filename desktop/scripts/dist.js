const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { stageServer } = require('./stage');
const { resolveTargets } = require('./targets');

const DESKTOP = path.join(__dirname, '..');
const CODE = path.join(DESKTOP, '..', 'code');

const args = process.argv.slice(2);
const unpacked = args.includes('--dir');
const targets = resolveTargets(args.filter((arg) => arg !== '--dir'));
const version = JSON.parse(fs.readFileSync(path.join(CODE, 'package.json'), 'utf8')).version;
const builder = require.resolve('electron-builder/cli.js', { paths: [DESKTOP] });
const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
delete env.ELECTRON_RUN_AS_NODE;

for (const target of targets) {
  console.log(`\nMock Server ${version} para ${target.name}`);
  stageServer(target);
  const [platformFlag, format, archFlag] = target.builder;
  const result = spawnSync(
    process.execPath,
    [builder, platformFlag, unpacked ? 'dir' : format, archFlag, `-c.extraMetadata.version=${version}`, '--publish', 'never'],
    { cwd: DESKTOP, stdio: 'inherit', env },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}
