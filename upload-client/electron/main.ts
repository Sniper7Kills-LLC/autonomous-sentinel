import { app, BrowserWindow, Tray, Menu, nativeImage } from 'electron';
import path from 'node:path';

let tray: Tray | null = null;
let win: BrowserWindow | null = null;

function createWindow() {
  win = new BrowserWindow({
    width: 720,
    height: 520,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (process.env.NODE_ENV === 'development') {
    void win.loadURL('http://localhost:5173');
  } else {
    void win.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  win.on('close', (event) => {
    if (!(app as unknown as { isQuitting?: boolean }).isQuitting) {
      event.preventDefault();
      win?.hide();
    }
  });
}

function createTray() {
  // TODO: replace with real icon asset
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('Autonomous Sentinel — Upload Client');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open', click: () => win?.show() },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          (app as unknown as { isQuitting?: boolean }).isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
}

void app.whenReady().then(() => {
  createWindow();
  createTray();
});

app.on('window-all-closed', () => {
  // Keep app alive in tray on all platforms — do not call app.quit().
});
