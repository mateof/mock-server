const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, Menu, Tray, clipboard, dialog, nativeTheme, shell } = require('electron');
const { applicationMenu, trayMenu } = require('./menus');
const { NETWORK_HOST, choosePort, networkLink } = require('./network');
const { ensureAccessKey, networkSettings, newAccessKey, preferredPort, readPreferences, writePreferences } = require('./preferences');
const { runImport, startServer } = require('./server');
const { stageDir } = require('./scripts/targets');

const TRAY_ICON = path.join(__dirname, 'assets', 'tray.png');
const DARK_BACKGROUND = '#12131c';
const LIGHT_BACKGROUND = '#f4f5fb';
const PLAIN_HTTP_WARNING =
  'La conexión va sin cifrar (http). Desde otros equipos el panel funciona, pero los botones de copiar no, porque el navegador solo los permite en conexiones seguras.';

let running = null;
let mainWindow = null;
let tray = null;
let quitting = false;
let busy = false;
let warnedAboutPort = false;

const userDir = () => app.getPath('userData');
const dataDir = () => process.env.MOCK_SERVER_DESKTOP_DATA_DIR || path.join(userDir(), 'data');
const databaseFile = () => path.join(dataDir(), 'database.db');
const backupDir = () => process.env.MOCK_SERVER_DESKTOP_BACKUP_DIR || path.join(os.homedir(), '.mock-server', 'desktop-backups');
const logFile = () => path.join(userDir(), 'server.log');
const serverDir = () =>
  app.isPackaged
    ? path.join(process.resourcesPath, 'server')
    : path.join(__dirname, '.stage', stageDir(process.platform, process.arch), 'server');
const preferences = () => readPreferences(userDir());
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

async function launchServer() {
  let current = preferences();
  if (current.exposed && current.requireKey) current = ensureAccessKey(userDir());
  const { host, accessKey } = networkSettings(current);
  const wanted = preferredPort(current);
  const port = await choosePort(running?.port ?? wanted, host);
  fs.mkdirSync(dataDir(), { recursive: true });
  running = await startServer({ serverDir: serverDir(), dataDir: dataDir(), port, host, accessKey, logFile: logFile() });
  running.child.on('exit', (code) => {
    if (quitting || busy) return;
    dialog.showErrorBox('El servidor de Mock Server se ha parado', `Código ${code}. Mira el registro en ${logFile()}`);
  });
  refreshTray();
  if (port !== wanted && !warnedAboutPort) {
    warnedAboutPort = true;
    dialog.showMessageBox({
      type: 'warning',
      message: `El puerto ${wanted} está ocupado`,
      detail:
        `Mock Server escucha en el ${port}. Puede que otro Mock Server (por ejemplo el contenedor de Docker) ya esté usando el ${wanted}. ` +
        `Los clientes que apunten a ${wanted} no llegarán a esta aplicación. El puerto se cambia en ${path.join(userDir(), 'desktop.json')}.`,
    });
  }
}

async function restartServer(work = async () => {}) {
  busy = true;
  try {
    await running?.stop();
    await work();
    await launchServer();
  } finally {
    busy = false;
  }
  mainWindow?.loadURL(running.url);
}

async function applyNetworkChange(changes) {
  writePreferences(userDir(), changes);
  try {
    await restartServer();
  } catch (error) {
    dialog.showErrorBox('No se ha podido reiniciar el servidor', error.message);
  }
}

function showWindow() {
  if (!mainWindow) createWindow();
  mainWindow.show();
  mainWindow.focus();
}

function openInBrowser() {
  shell.openExternal(running.url);
}

function samePanel(url) {
  try {
    return new URL(url).origin === new URL(running.url).origin;
  } catch {
    return false;
  }
}

function openOutside(url) {
  if (/^https?:|^mailto:/.test(url)) shell.openExternal(url);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 560,
    title: 'Mock Server',
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? DARK_BACKGROUND : LIGHT_BACKGROUND,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (samePanel(url)) return { action: 'allow' };
    openOutside(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (samePanel(url)) return;
    event.preventDefault();
    openOutside(url);
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.loadURL(running.url);
}

function refreshTray() {
  if (!tray || !running) return;
  const current = preferences();
  const exposed = running.host === NETWORK_HOST;
  const link = networkLink(running.port);
  tray.setToolTip(exposed ? `Mock Server · ${link ?? running.url}` : `Mock Server · ${running.url}`);
  tray.setContextMenu(
    trayMenu({
      url: running.url,
      exposed,
      requireKey: current.requireKey,
      networkLink: exposed ? link : null,
      showWindow,
      openInBrowser,
      copyNetworkLink: () => clipboard.writeText(link),
      toggleNetwork,
      toggleKey,
      copyKey,
      renewKey,
      quit: () => app.quit(),
    }),
  );
}

async function confirm({ message, detail, accept }) {
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    message,
    detail,
    buttons: [accept, 'Cancelar'],
    defaultId: 1,
    cancelId: 1,
  });
  return response === 0;
}

const OPEN_ADMIN_WARNING =
  'Cualquiera en tu red podrá administrar Mock Server sin clave, y eso incluye ejecutar código en este equipo con los scripts y criterios de las rutas. Hazlo solo en una red de confianza.';

async function toggleNetwork() {
  const current = preferences();
  if (current.exposed) {
    await applyNetworkChange({ exposed: false });
    return;
  }
  const detail = current.requireKey
    ? 'Otros equipos podrán llamar a los mocks sin nada más. Para abrir el panel, la API o el MCP necesitarán la clave de acceso, que copias desde este menú.\n\n' +
      `${PLAIN_HTTP_WARNING} La clave viaja también en claro.`
    : `${OPEN_ADMIN_WARNING}\n\n${PLAIN_HTTP_WARNING}`;
  const accepted = await confirm({ message: '¿Permitir el acceso desde otros equipos de la red?', detail, accept: 'Permitir' });
  if (!accepted) {
    refreshTray();
    return;
  }
  await applyNetworkChange({ exposed: true });
}

async function toggleKey() {
  const current = preferences();
  if (current.requireKey) {
    if (current.exposed) {
      const accepted = await confirm({ message: '¿Dejar de pedir la clave a otros equipos?', detail: OPEN_ADMIN_WARNING, accept: 'Dejar de pedirla' });
      if (!accepted) {
        refreshTray();
        return;
      }
      await applyNetworkChange({ requireKey: false });
      return;
    }
    writePreferences(userDir(), { requireKey: false });
    refreshTray();
    return;
  }
  ensureAccessKey(userDir());
  if (current.exposed) {
    await applyNetworkChange({ requireKey: true });
    await offerKey();
    return;
  }
  writePreferences(userDir(), { requireKey: true });
  refreshTray();
}

function copyKey() {
  clipboard.writeText(ensureAccessKey(userDir()).accessKey);
}

async function offerKey() {
  const { response } = await dialog.showMessageBox({
    type: 'info',
    message: 'Clave de acceso para otros equipos',
    detail: 'Desde otro equipo, el panel la pide al entrar. Los scripts y asistentes la mandan como Authorization: Bearer o X-API-Key.',
    buttons: ['Copiar la clave', 'Cerrar'],
  });
  if (response === 0) copyKey();
}

async function renewKey() {
  const accepted = await confirm({
    message: '¿Generar una clave de acceso nueva?',
    detail: 'La actual deja de valer: quien haya entrado desde otro equipo tendrá que escribir la nueva, y los scripts o asistentes que la usen dejarán de funcionar.',
    accept: 'Generar',
  });
  if (!accepted) return;
  const current = preferences();
  if (current.exposed && current.requireKey) await applyNetworkChange({ accessKey: newAccessKey() });
  else writePreferences(userDir(), { accessKey: newAccessKey() });
  await offerKey();
}

async function chooseDatabase() {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Importar datos de Mock Server',
    message: 'Elige el database.db de tu instalación. En el repositorio está en code/data; en Docker, en el volumen montado en /app/data',
    buttonLabel: 'Importar',
    properties: ['openFile', 'showHiddenFiles'],
    filters: [{ name: 'Base de datos de Mock Server', extensions: ['db'] }],
  });
  return canceled ? null : filePaths[0];
}

async function importData() {
  const source = await chooseDatabase();
  if (!source) return;
  if (fs.existsSync(databaseFile())) {
    const accepted = await confirm({
      message: '¿Sustituir los datos de la aplicación por los de esa instalación?',
      detail: `Antes se apartan los actuales a ${backupDir()}. El fichero elegido no se modifica.`,
      accept: 'Sustituir',
    });
    if (!accepted) return;
  }
  await importFrom(source);
}

async function importFrom(source) {
  let result = null;
  const work = async () => {
    result = await runImport({ serverDir: serverDir(), source, dataDir: dataDir(), backupDir: backupDir() });
  };
  try {
    if (running) await restartServer(work);
    else await work();
  } catch (error) {
    dialog.showErrorBox('No se han podido importar los datos', error.message);
    if (running && running.child.pid === undefined) await launchServer().catch(() => {});
    return;
  }
  await dialog.showMessageBox({
    type: 'info',
    message: 'Datos importados',
    detail:
      `${plural(result.routes, 'ruta', 'rutas')} y ${plural(result.files, 'fichero subido', 'ficheros subidos')}. El original sigue intacto.` +
      (result.previous ? `\n\nLos datos que había quedan en ${result.previous}.` : ''),
  });
}

async function offerFirstImport() {
  if (fs.existsSync(databaseFile()) || process.env.MOCK_SERVER_DESKTOP_SKIP_IMPORT === '1') return;
  const { response } = await dialog.showMessageBox({
    type: 'question',
    message: '¿Tienes ya datos de Mock Server?',
    detail:
      'Elige su database.db y la aplicación se lleva una copia: rutas, tags, entornos, ficheros subidos, log y tokens MCP. ' +
      'El original no se toca. También está en Archivo, Importar datos de otra instalación.',
    buttons: ['Importar', 'Empezar de cero'],
    cancelId: 1,
  });
  if (response !== 0) return;
  const source = await chooseDatabase();
  if (source) await importFrom(source);
}

async function launch() {
  await offerFirstImport();
  await launchServer();
  Menu.setApplicationMenu(
    applicationMenu({
      openInBrowser,
      importData,
      showDataFolder: () => shell.openPath(dataDir()),
      showLog: () => shell.showItemInFolder(logFile()),
    }),
  );
  tray = new Tray(TRAY_ICON);
  refreshTray();
  createWindow();
}

if (!app.isPackaged) app.setPath('userData', `${app.getPath('userData')} Dev`);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setName('Mock Server');
  app.on('second-instance', () => running && showWindow());
  app.on('activate', () => running && showWindow());
  app.on('window-all-closed', () => {});
  app.on('before-quit', async (event) => {
    if (quitting || !running) {
      quitting = true;
      return;
    }
    event.preventDefault();
    quitting = true;
    await running.stop();
    app.quit();
  });
  app.whenReady().then(launch).catch((error) => {
    dialog.showErrorBox('Mock Server no ha podido arrancar', error.message);
    app.exit(1);
  });
}
