const TARGETS = {
  'mac-arm64': { platform: 'darwin', arch: 'arm64', libc: 'unknown', builder: ['--mac', 'dmg', '--arm64'] },
  'mac-x64': { platform: 'darwin', arch: 'x64', libc: 'unknown', builder: ['--mac', 'dmg', '--x64'] },
  'win-x64': { platform: 'win32', arch: 'x64', libc: 'unknown', builder: ['--win', 'nsis', '--x64'] },
  'linux-x64': { platform: 'linux', arch: 'x64', libc: 'glibc', builder: ['--linux', 'AppImage', '--x64'] },
  'linux-arm64': { platform: 'linux', arch: 'arm64', libc: 'glibc', builder: ['--linux', 'AppImage', '--arm64'] },
};

const HOST = { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform];

function hostTarget() {
  return `${HOST}-${process.arch}`;
}

function resolveTargets(names) {
  const wanted = names.length === 0 ? [hostTarget()] : names.includes('all') ? Object.keys(TARGETS) : names;
  const unknown = wanted.filter((name) => !TARGETS[name]);
  if (unknown.length > 0) {
    throw new Error(`Destino desconocido: ${unknown.join(', ')}. Los que hay: ${Object.keys(TARGETS).join(', ')}, all`);
  }
  return wanted.map((name) => ({ name, ...TARGETS[name] }));
}

function stageDir(platform, arch) {
  return `${platform}-${arch}`;
}

function sqliteBinding({ platform, arch, libc }) {
  return `napi-v6-${platform}-${libc}-${arch}`;
}

module.exports = { TARGETS, hostTarget, resolveTargets, sqliteBinding, stageDir };
