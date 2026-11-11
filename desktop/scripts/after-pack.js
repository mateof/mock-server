const fs = require('node:fs');
const path = require('node:path');
const { Arch } = require('builder-util');
const { stageDir } = require('./targets');

function resourcesDir({ appOutDir, packager, electronPlatformName }) {
  if (electronPlatformName === 'darwin') {
    return path.join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources');
  }
  return path.join(appOutDir, 'resources');
}

exports.default = async function copyServer(context) {
  const source = path.join(__dirname, '..', '.stage', stageDir(context.electronPlatformName, Arch[context.arch]), 'server');
  if (!fs.existsSync(source)) throw new Error(`No hay servidor preparado en ${source}`);
  const target = path.join(resourcesDir(context), 'server');
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(source, target, { recursive: true, verbatimSymlinks: true });
};
