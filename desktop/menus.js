const { Menu } = require('electron');

function applicationMenu({ openInBrowser, importData, showDataFolder, showLog }) {
  return Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'Archivo',
      submenu: [
        { label: 'Abrir en el navegador', accelerator: 'CmdOrCtrl+Shift+B', click: openInBrowser },
        { label: 'Importar datos de otra instalación…', click: importData },
        { label: 'Mostrar la carpeta de datos', click: showDataFolder },
        { label: 'Mostrar el registro del servidor', click: showLog },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]);
}

function trayMenu({
  url,
  exposed,
  requireKey,
  networkLink,
  showWindow,
  openInBrowser,
  copyNetworkLink,
  toggleNetwork,
  toggleKey,
  copyKey,
  renewKey,
  quit,
}) {
  return Menu.buildFromTemplate([
    { label: 'Abrir Mock Server', click: showWindow },
    { label: 'Abrir en el navegador', click: openInBrowser },
    { label: url, enabled: false },
    { type: 'separator' },
    { label: 'Permitir acceso desde la red', type: 'checkbox', checked: exposed, click: toggleNetwork },
    { label: 'Pedir clave de acceso a otros equipos', type: 'checkbox', checked: requireKey, click: toggleKey },
    {
      label: networkLink ? `Copiar enlace para otros equipos (${networkLink})` : 'Copiar enlace para otros equipos',
      enabled: exposed && Boolean(networkLink),
      click: copyNetworkLink,
    },
    { label: 'Copiar la clave de acceso', enabled: requireKey, click: copyKey },
    { label: 'Generar una clave nueva…', enabled: requireKey, click: renewKey },
    { type: 'separator' },
    { label: 'Salir', click: quit },
  ]);
}

module.exports = { applicationMenu, trayMenu };
