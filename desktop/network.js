const net = require('node:net');
const os = require('node:os');

const LOCAL_HOST = '127.0.0.1';
const NETWORK_HOST = '0.0.0.0';

function lanAddresses(interfaces = os.networkInterfaces()) {
  return Object.values(interfaces)
    .flat()
    .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);
}

function networkLink(port, interfaces) {
  const [address] = lanAddresses(interfaces);
  return address ? `http://${address}:${port}` : null;
}

function answers(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: LOCAL_HOST, port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

function listensOn(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(null));
    server.listen({ port, host, exclusive: true }, () => {
      const { port: bound } = server.address();
      server.close(() => resolve(bound));
    });
  });
}

async function choosePort(preferred, host, probe = { answers, listensOn }) {
  if (!(await probe.answers(preferred)) && (await probe.listensOn(preferred, host)) !== null) {
    return preferred;
  }
  const any = await probe.listensOn(0, host);
  if (any === null) throw new Error('No hay ningún puerto libre para arrancar el servidor');
  return any;
}

module.exports = { LOCAL_HOST, NETWORK_HOST, choosePort, lanAddresses, networkLink };
