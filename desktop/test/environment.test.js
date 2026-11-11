const assert = require('node:assert/strict');
const { afterEach, describe, it } = require('node:test');
const { RELEASES_URL, serverEnvironment } = require('../environment');

const base = { port: 3880, host: '127.0.0.1', dataDir: '/datos', accessKey: null };

describe('el entorno del servidor', () => {
  const previous = process.env.MOCK_SERVER_ACCESS_KEY;
  afterEach(() => {
    if (previous === undefined) delete process.env.MOCK_SERVER_ACCESS_KEY;
    else process.env.MOCK_SERVER_ACCESS_KEY = previous;
  });

  it('pasa puerto, interfaz y carpeta de datos con los nombres que lee el servidor', () => {
    const env = serverEnvironment(base);
    assert.equal(env.PORT, '3880');
    assert.equal(env.MOCK_SERVER_HOST, '127.0.0.1');
    assert.equal(env.MOCK_SERVER_DATA_DIR, '/datos');
  });

  it('manda el aviso de versión nueva a las releases de escritorio y no a la imagen', () => {
    assert.equal(serverEnvironment(base).MOCK_SERVER_UPDATE_URL, RELEASES_URL);
  });

  it('no hereda una clave del entorno de quien abrió la app cuando la preferencia es no pedirla', () => {
    process.env.MOCK_SERVER_ACCESS_KEY = 'heredada';
    assert.equal('MOCK_SERVER_ACCESS_KEY' in serverEnvironment(base), false);
    assert.equal(serverEnvironment({ ...base, accessKey: 'propia' }).MOCK_SERVER_ACCESS_KEY, 'propia');
  });

  it('no arranca el servidor como Node pelado aunque la app lo esté', () => {
    process.env.ELECTRON_RUN_AS_NODE = '1';
    try {
      assert.equal('ELECTRON_RUN_AS_NODE' in serverEnvironment(base), false);
    } finally {
      delete process.env.ELECTRON_RUN_AS_NODE;
    }
  });
});
