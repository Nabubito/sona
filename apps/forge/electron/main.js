// Forge by Sona: optional app window. Wraps the local server in a real
// window and adds native file dialogs + installer launch. It shows the same
// passcode gate as the browser does; there is no bypass.
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const cfg = require('../lib/config');

const PORT = cfg.PORT;
const ORIGIN = `http://localhost:${PORT}`;

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = { 'Origin': ORIGIN, 'Referer': ORIGIN + '/' };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    const r = http.request(ORIGIN + p, { method, headers }, resp => {
      let b = ''; resp.on('data', d => b += d);
      resp.on('end', () => resolve({ status: resp.statusCode, headers: resp.headers, body: b }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function waitServer() {
  for (let i = 0; i < 50; i++) {
    try { const r = await req('GET', '/health'); if (r.status === 200) return true; } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

// If a Forge server isn't already running, start one using Electron's
// bundled node so the app window is self-contained.
async function ensureServer() {
  try { const r = await req('GET', '/health'); if (r.status === 200) return true; } catch {}
  const serverPath = path.join(__dirname, '..', 'server.js');
  spawn(process.execPath, [serverPath], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1', FORGE_PORT: String(PORT) }),
    stdio: 'ignore', windowsHide: true, detached: false
  });
  return waitServer();
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 1040, minHeight: 660,
    backgroundColor: '#161311', title: 'Forge', autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'public', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  });
  win.loadURL(ORIGIN);
  return win;
}

// ---- native IPC: real Windows dialogs + host actions ----
// Parent every dialog to the focused window so the Explorer picker opens ON TOP,
// modal, and never gets lost behind the app.
const winOf = e => BrowserWindow.fromWebContents(e.sender) || BrowserWindow.getFocusedWindow();
ipcMain.handle('forge:pickFile', async (_e, opts) => {
  const r = await dialog.showOpenDialog(winOf(_e), { title: 'Open a file', properties: ['openFile'], filters: (opts && opts.filters) || [] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('forge:pickFiles', async (_e) => {
  const r = await dialog.showOpenDialog(winOf(_e), { title: 'Open files', properties: ['openFile', 'multiSelections'] });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('forge:pickFolder', async (_e) => {
  const r = await dialog.showOpenDialog(winOf(_e), { title: 'Choose a folder', properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('forge:saveAs', async (_e, name) => {
  const r = await dialog.showSaveDialog(winOf(_e), { title: 'Save as', defaultPath: name || 'output' });
  return r.canceled ? null : r.filePath;
});
ipcMain.handle('forge:reveal', async (_e, p) => { shell.showItemInFolder(String(p).replace(/\//g, '\\')); return true; });
// Only a bare drive letter (like "E", optionally with a colon and one slash) is accepted from the page.
const driveLetter = d => { const m = /^([A-Za-z]):?[\\/]?$/.exec(String(d || '')); return m ? m[1].toUpperCase() : null; };
ipcMain.handle('forge:openDrive', async (_e, drive) => { const L = driveLetter(drive); if (!L) return false; shell.openPath(L + ':\\'); return true; });

// Launch the installer/autorun straight off a mounted drive.
ipcMain.handle('forge:runInstaller', async (_e, drive) => {
  drive = driveLetter(drive);
  if (!drive) return { launched: false, error: 'bad drive letter' };
  const root = drive + ':\\';
  let target = null;
  try {
    const inf = fs.readFileSync(root + 'autorun.inf', 'utf8');
    const m = inf.match(/^\s*open\s*=\s*(.+)$/im) || inf.match(/^\s*shellexecute\s*=\s*(.+)$/im);
    if (m) target = m[1].trim().split(',')[0].trim();
  } catch {}
  if (!target) {
    for (const c of ['setup.exe', 'install.exe', 'autorun.exe', 'start.exe', 'Setup.exe']) {
      try { if (fs.existsSync(root + c)) { target = c; break; } } catch {}
    }
  }
  if (!target) { shell.openPath(root); return { launched: false, opened: 'explorer' }; }
  const full = path.isAbsolute(target) ? target : (root + target);
  const err = await shell.openPath(full);
  return { launched: err === '', target, error: err || null };
});

// ---- shell integration: single instance + right-click file handling ----
let mainWin = null, pendingJob = null, winReady = false;
const APP_ROOT = path.resolve(__dirname, '..').replace(/\\/g, '/').toLowerCase();
function parseJob(argv) {
  let verb = null, file = null;
  for (let i = 1; i < argv.length; i++) {   // skip argv[0] (the electron exe)
    const a = argv[i];
    if (a.startsWith('--forge-verb=')) { verb = a.slice(13); continue; }
    if (a.startsWith('--forge-file=')) { file = a.slice(13).replace(/^"|"$/g, ''); continue; }
    if (a.startsWith('--')) continue;
    if (/\.exe$/i.test(a)) continue;                          // never the launcher exe
    if (a.replace(/\\/g, '/').toLowerCase() === APP_ROOT) continue;  // nor the app dir
    if (/\.[a-z0-9]{1,6}$/i.test(a)) { try { if (fs.existsSync(a)) file = a; } catch {} }  // last real file wins (the %1)
  }
  return file ? { verb: verb || 'open', file: file.replace(/\\/g, '/') } : null;
}
function dispatch(job) {
  if (!job) return;
  if (winReady && mainWin) {
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.show(); mainWin.focus();
    mainWin.webContents.send('forge:handle', job);
  } else { pendingJob = job; }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
else {
  // a second launch (e.g. right-click "Mount with Forge") hands its argv to us
  app.on('second-instance', (_e, argv) => dispatch(parseJob(argv)));

  app.whenReady().then(async () => {
    await ensureServer();
    mainWin = createWindow();
    mainWin.webContents.on('did-finish-load', () => { winReady = true; if (pendingJob) setTimeout(() => { const j = pendingJob; pendingJob = null; dispatch(j); }, 120); });
    dispatch(parseJob(process.argv));   // handle a file passed on first launch too
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) mainWin = createWindow(); });
  });
}
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
