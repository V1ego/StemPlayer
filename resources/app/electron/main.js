/**
 * Electron main process.
 *
 * Responsibilities:
 * 1. Start the NeteaseCloudMusicApi proxy server (node netease_proxy.js, port 4000)
 * 2. Start the Python Flask backend (run.py, port 5000)
 * 3. Wait for Flask to be ready
 * 4. Open a BrowserWindow pointing to http://127.0.0.1:5000
 * 5. Clean up on exit
 */
const { app, BrowserWindow, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');

const LOG_FILE = path.join(process.env.APPDATA || __dirname, 'ilya', 'debug.log');
function logToFile(msg) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

let mainWindow = null;
let pythonProcess = null;
let proxyProcess = null;

// ---- Paths ----

function getProjectRoot() {
  return path.join(__dirname, '..');
}

function getPythonExe() {
  const root = getProjectRoot();
  const devPython = path.join(root, '.venv', 'Scripts', 'python.exe');
  try { if (fs.existsSync(devPython)) return devPython; } catch {}
  return path.join(process.resourcesPath, 'python', 'Scripts', 'python.exe');
}

function getFFmpegPath() {
  const root = getProjectRoot();
  const devFFmpeg = path.join(root, '.ffmpeg', 'ffmpeg-master-latest-win64-gpl-shared', 'bin');
  try { if (fs.existsSync(devFFmpeg)) return devFFmpeg; } catch {}
  return path.join(process.resourcesPath, '.ffmpeg', 'ffmpeg-master-latest-win64-gpl-shared', 'bin');
}

// ---- Proxy server (NetEase API on port 4000) ----

function startProxyProcess() {
  const root = getProjectRoot();
  const proxyScript = path.join(root, 'netease_proxy.js');
  if (!fs.existsSync(proxyScript)) {
    logToFile('Proxy script not found: ' + proxyScript);
    return null;
  }

  logToFile('Proxy: spawning ' + proxyScript);
  const proc = spawn('node', [proxyScript], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  proc.stdout.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) console.log('[proxy]', msg);
  });
  proc.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) console.error('[proxy:err]', msg);
  });
  proc.on('exit', (code) => {
    console.log('[proxy] exited with code', code);
    proxyProcess = null;
  });

  return proc;
}

// ---- Python backend ----

function startPythonServer() {
  const pythonExe = getPythonExe();
  const root = getProjectRoot();
  const ffmpegBin = getFFmpegPath();

  const env = { ...process.env, PATH: ffmpegBin + ';' + (process.env.PATH || ''), PROXY_BY_ELECTRON: '1' };

  console.log('[main] Starting Python server:', pythonExe);
  console.log('[main] Project root:', root);

  pythonProcess = spawn(pythonExe, ['run.py'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  pythonProcess.stdout.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) console.log('[python]', msg);
  });
  pythonProcess.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) console.error('[python:err]', msg);
  });
  pythonProcess.on('exit', (code) => {
    console.log('[python] exited with code', code);
    pythonProcess = null;
  });
}

function waitForServer(url, maxRetries = 60, interval = 500) {
  return new Promise((resolve, reject) => {
    let retries = 0;
    function check() {
      const req = http.get(url, (res) => {
        if (res.statusCode === 200 || res.statusCode === 404) resolve();
        else retry();
        res.resume();
      });
      req.on('error', () => retry());
      req.setTimeout(2000, () => { req.destroy(); retry(); });
    }
    function retry() {
      retries++;
      if (retries >= maxRetries) reject(new Error('Server at ' + url + ' did not start in time'));
      else setTimeout(check, interval);
    }
    check();
  });
}

// ---- Window creation ----

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: 'ilya',
    backgroundColor: '#1a1a1a',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      devTools: !app.isPackaged,
    },
  });

  mainWindow.loadURL('http://127.0.0.1:5000');

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http') && !url.startsWith('http://127.0.0.1')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ---- App lifecycle ----

app.whenReady().then(async () => {
  logToFile('=== App starting ===');
  logToFile('execPath=' + process.execPath);
  logToFile('resourcesPath=' + (process.resourcesPath || 'N/A'));

  // Start proxy server (NetEase API on port 4000) as a child process
  try {
    proxyProcess = startProxyProcess();
    logToFile(proxyProcess ? 'Proxy process started' : 'Proxy script not found');
  } catch (err) {
    logToFile('Failed to start proxy: ' + err.message);
  }

  // Start Python backend (Flask on port 5000)
  startPythonServer();

  // Wait for Flask to be ready
  try {
    console.log('[main] Waiting for Flask server...');
    await waitForServer('http://127.0.0.1:5000/');
    console.log('[main] Flask server is ready!');
  } catch (err) {
    console.error('[main] Failed to start Flask:', err.message);
  }

  createWindow();
});

app.on('window-all-closed', () => { cleanup(); app.quit(); });
app.on('before-quit', () => { cleanup(); });
app.on('activate', () => { if (mainWindow === null) createWindow(); });

function cleanup() {
  if (proxyProcess) {
    try { proxyProcess.kill(); } catch {}
    proxyProcess = null;
  }
  if (pythonProcess) {
    try { pythonProcess.kill('SIGTERM'); } catch {}
    pythonProcess = null;
  }
}

process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(); });
process.on('SIGTERM', () => { cleanup(); process.exit(); });
