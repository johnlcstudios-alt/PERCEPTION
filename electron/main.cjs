/* PERCEPTION - Electron main process */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

let win = null;
let logStream = null;

function savePath(name) {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(name).replace(/[^a-z0-9_\- .]/gi, '_');
  return path.join(dir, safe + '.json');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1100,
    minHeight: 640,
    backgroundColor: '#04060b',
    autoHideMenuBar: true,
    show: false,
    title: 'PERCEPTION',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  win.setMenuBarVisibility(false);
  const loadOpts = process.argv.includes('--autotest') ? { search: 'autotest=1' } : undefined;
  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), loadOpts);
  win.once('ready-to-show', () => { win.show(); if (process.argv.includes('--windowed')) win.unmaximize(); else win.maximize(); });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[PERCEPTION] renderer gone:', details.reason);
    try { fs.appendFileSync(savePath('crash-log'), new Date().toISOString() + ' renderer gone: ' + details.reason + '\n'); } catch (_) {}
  });
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) { console.log('[renderer]', message); try { fs.appendFileSync(savePath('crash-log'), new Date().toISOString() + ' ' + message + '\n'); } catch (_) {} }
  });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

/* ---- save bridge ---- */
ipcMain.handle('perception:read-save', (_e, name) => {
  try {
    const p = savePath(name);
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p, 'utf8');
  } catch (err) { return null; }
});
ipcMain.handle('perception:write-save', (_e, name, data) => {
  try {
    fs.writeFileSync(savePath(name), String(data), 'utf8');
    return true;
  } catch (err) { return false; }
});
ipcMain.handle('perception:delete-save', (_e, name) => {
  try { const p = savePath(name); if (fs.existsSync(p)) fs.unlinkSync(p); return true; } catch (err) { return false; }
});
ipcMain.handle('perception:meta', () => ({ version: app.getVersion(), platform: process.platform, isElectron: true }));
ipcMain.handle('perception:save-png', (_e, dataUrl, name) => {
  try {
    const b64 = String(dataUrl).split(',')[1];
    fs.writeFileSync(savePath(name), Buffer.from(b64, 'base64'));
    return true;
  } catch (err) { return false; }
});
ipcMain.handle('app:quit', () => { app.quit(); return true; });
ipcMain.handle('app:capture', async (_e, name) => {
  try {
    if (!win) return false;
    const img = await win.webContents.capturePage();
    fs.writeFileSync(savePath(name || 'screenshot'), img.toPNG());
    return true;
  } catch (err) { return false; }
});
