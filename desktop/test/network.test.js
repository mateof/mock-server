const assert = require('node:assert/strict');
const net = require('node:net');
const { describe, it } = require('node:test');
const { LOCAL_HOST, choosePort, lanAddresses, networkLink } = require('../network');

const interfaces = {
  lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
  en0: [
    { family: 'IPv6', address: 'fe80::1', internal: false },
    { family: 'IPv4', address: '192.168.1.40', internal: false },
  ],
};

function occupy(host) {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, host, () => resolve(server));
  });
}

describe('el enlace para otros equipos', () => {
  it('usa la IPv4 de la red local, nunca loopback ni IPv6', () => {
    assert.deepEqual(lanAddresses(interfaces), ['192.168.1.40']);
    assert.equal(networkLink(3880, interfaces), 'http://192.168.1.40:3880');
  });

  it('no ofrece enlace si no hay red', () => {
    assert.equal(networkLink(3880, { lo0: interfaces.lo0 }), null);
  });
});

describe('la elección del puerto', () => {
  it('se queda con el preferido si está libre, para que los clientes que apuntan a los mocks sigan llegando', async () => {
    const probe = { answers: async () => false, listensOn: async (port) => port };
    assert.equal(await choosePort(3880, LOCAL_HOST, probe), 3880);
  });

  it('se aparta de un puerto en el que ya contesta otro Mock Server, aunque se pudiera abrir', async () => {
    const probe = { answers: async (port) => port === 3880, listensOn: async (port) => (port === 0 ? 51234 : port) };
    assert.equal(await choosePort(3880, LOCAL_HOST, probe), 51234);
  });

  it('se aparta de un puerto que no puede abrir aunque nadie conteste en él', async () => {
    const probe = { answers: async () => false, listensOn: async (port) => (port === 3880 ? null : 51234) };
    assert.equal(await choosePort(3880, LOCAL_HOST, probe), 51234);
  });

  it('evita de verdad un puerto que algo de este equipo ya está escuchando', async () => {
    const taken = await occupy('0.0.0.0');
    try {
      const chosen = await choosePort(taken.address().port, LOCAL_HOST);
      assert.notEqual(chosen, taken.address().port);
    } finally {
      taken.close();
    }
  });
});
