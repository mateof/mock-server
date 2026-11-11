const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { hostTarget, resolveTargets, sqliteBinding, stageDir } = require('../scripts/targets');

describe('qué se construye', () => {
  it('construye para este equipo si no se nombra ninguno', () => {
    assert.deepEqual(resolveTargets([]).map((target) => target.name), [hostTarget()]);
  });

  it('construye todas las plataformas con all', () => {
    assert.deepEqual(
      resolveTargets(['all']).map((target) => target.name),
      ['mac-arm64', 'mac-x64', 'win-x64', 'linux-x64', 'linux-arm64'],
    );
  });

  it('dice qué destinos hay cuando se pide uno que no existe', () => {
    assert.throws(() => resolveTargets(['windows']), /Destino desconocido: windows\. Los que hay: mac-arm64/);
  });

  it('separa el servidor preparado por plataforma y arquitectura, para no mezclar binarios', () => {
    assert.notEqual(stageDir('darwin', 'arm64'), stageDir('darwin', 'x64'));
    assert.equal(stageDir('win32', 'x64'), 'win32-x64');
  });

  it('busca el binario de sqlite3 con el nombre exacto que publica node-sqlite3', () => {
    const [linux] = resolveTargets(['linux-arm64']);
    const [mac] = resolveTargets(['mac-x64']);
    const [windows] = resolveTargets(['win-x64']);
    assert.equal(sqliteBinding(linux), 'napi-v6-linux-glibc-arm64');
    assert.equal(sqliteBinding(mac), 'napi-v6-darwin-unknown-x64');
    assert.equal(sqliteBinding(windows), 'napi-v6-win32-unknown-x64');
  });
});
