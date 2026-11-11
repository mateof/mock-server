const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');
const { LOCAL_HOST, NETWORK_HOST } = require('../network');
const { ensureAccessKey, networkSettings, newAccessKey, preferredPort, readPreferences, writePreferences } = require('../preferences');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mock-server-prefs-'));

describe('las preferencias de escritorio', () => {
  it('empiezan cerradas a la red, pidiendo clave si se abre, y en el puerto de siempre', () => {
    assert.deepEqual(readPreferences(tempDir()), { exposed: false, requireKey: true, accessKey: null, port: 3880 });
  });

  it('recuerdan lo elegido y conservan lo demás', () => {
    const dir = tempDir();
    writePreferences(dir, { exposed: true, port: 4000 });
    writePreferences(dir, { exposed: false });
    assert.equal(readPreferences(dir).port, 4000);
    assert.equal(readPreferences(dir).exposed, false);
  });

  it('vuelven a cerradas si el fichero no se puede leer', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'desktop.json'), '{ no es json');
    assert.equal(readPreferences(dir).exposed, false);
  });

  it('dejan el fichero legible solo por su dueño, porque lleva la clave de acceso, aunque ya existiera con otros permisos', { skip: process.platform === 'win32' }, () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'desktop.json'), '{}', { mode: 0o644 });
    writePreferences(dir, { accessKey: 'x' });
    assert.equal(fs.statSync(path.join(dir, 'desktop.json')).mode & 0o777, 0o600);
  });
});

describe('la clave de acceso', () => {
  it('se genera una vez y se mantiene entre arranques, para no echar a quien ya entró', () => {
    const dir = tempDir();
    const first = ensureAccessKey(dir).accessKey;
    assert.equal(ensureAccessKey(dir).accessKey, first);
  });

  it('es larga y aleatoria', () => {
    const key = newAccessKey();
    assert.ok(key.length >= 32);
    assert.notEqual(newAccessKey(), key);
  });
});

describe('cómo se arranca el servidor según las preferencias', () => {
  it('cerrado a la red escucha solo en este equipo y no pide clave', () => {
    assert.deepEqual(networkSettings({ exposed: false, requireKey: true, accessKey: 'k' }), { host: LOCAL_HOST, accessKey: null });
  });

  it('abierto con clave escucha en todas las interfaces y se la pasa al servidor', () => {
    assert.deepEqual(networkSettings({ exposed: true, requireKey: true, accessKey: 'k' }), { host: NETWORK_HOST, accessKey: 'k' });
  });

  it('abierto sin clave escucha en todas las interfaces y no la pasa, aunque haya una guardada', () => {
    assert.deepEqual(networkSettings({ exposed: true, requireKey: false, accessKey: 'k' }), { host: NETWORK_HOST, accessKey: null });
  });

  it('usa el puerto guardado y vuelve al 3880 si el guardado no es un puerto', () => {
    assert.equal(preferredPort({ port: 4100 }), 4100);
    assert.equal(preferredPort({ port: 'abc' }), 3880);
    assert.equal(preferredPort({ port: 70000 }), 3880);
  });
});
