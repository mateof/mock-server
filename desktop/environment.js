const RELEASES_URL = 'https://github.com/mateof/mock-server/releases/latest';

function serverEnvironment({ port, host, dataDir, accessKey }) {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(port),
    MOCK_SERVER_HOST: host,
    MOCK_SERVER_DATA_DIR: dataDir,
    MOCK_SERVER_UPDATE_URL: RELEASES_URL,
  };
  delete env.MOCK_SERVER_ACCESS_KEY;
  delete env.ELECTRON_RUN_AS_NODE;
  if (accessKey) env.MOCK_SERVER_ACCESS_KEY = accessKey;
  return env;
}

module.exports = { RELEASES_URL, serverEnvironment };
