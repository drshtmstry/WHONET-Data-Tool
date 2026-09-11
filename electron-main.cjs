const { app, BrowserWindow, dialog } = require('electron');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const SERVER_URL = 'http://127.0.0.1:7890';
let mainWindow;

async function waitForServer(timeoutMs = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${SERVER_URL}/api/databases`);
      if (response.ok) return;
    } catch (_) {
      // The server is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('The local WHONET server did not start in time.');
}

async function createWindow() {
  process.env.WHONET_NO_BROWSER = '1';
  process.env.WHONET_NO_WATCH = '1';

  try {
    await import(pathToFileURL(path.join(__dirname, 'server.js')).href);
    await waitForServer();
  } catch (error) {
    await dialog.showMessageBox({
      type: 'error',
      title: 'WHONET Data Tool',
      message: 'The local database service could not start.',
      detail: error.stack || error.message,
    });
    app.quit();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'WHONET Data Tool',
    icon: path.join(__dirname, 'src', 'dev-icon.png'),
    backgroundColor: '#10151d',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.removeMenu();
  await mainWindow.loadURL(SERVER_URL);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});
