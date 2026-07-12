/**
 * Electron main process.
 *
 * Responsibilities:
 * 1. Start the NeteaseCloudMusicApi proxy server (inline, port 4000)
 * 2. Start the Python Flask backend (run.py, port 5000)
 * 3. Wait for Flask to be ready
 * 4. Open a BrowserWindow pointing to http://127.0.0.1:5000
 * 5. Clean up on exit
 */
const { app, BrowserWindow, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const url = require('url');
const fs = require('fs');

// Suppress uncaught exception dialog for known port-in-use errors
process.on('uncaughtException', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.log('[main] Port already in use — ignoring:', err.message);
  } else {
    console.error('[main] Uncaught exception:', err);
  }
});

// Debug log to file (for troubleshooting packaged app)
const LOG_FILE = path.join(process.env.APPDATA || __dirname, 'ilya', 'debug.log');
function logToFile(msg) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

let mainWindow = null;
let pythonProcess = null;

// ---- Paths ----

function getProjectRoot() {
  return path.join(__dirname, '..');
}

function pythonExeExists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

function getPythonExe() {
  // Packaged: always use bundled Python from extraResources
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'python', 'Scripts', 'python.exe');
  }
  // Dev: use .venv if it exists
  const root = getProjectRoot();
  const devPython = path.join(root, '.venv', 'Scripts', 'python.exe');
  if (pythonExeExists(devPython)) {
    return devPython;
  }
  // Fallback: bundled Python
  return path.join(process.resourcesPath, 'python', 'Scripts', 'python.exe');
}

function getFFmpegPath() {
  const root = getProjectRoot();
  const devFFmpeg = path.join(root, '.ffmpeg', 'ffmpeg-master-latest-win64-gpl-shared', 'bin');
  try { if (fs.existsSync(devFFmpeg)) return devFFmpeg; } catch {}
  return path.join(process.resourcesPath, '.ffmpeg', 'ffmpeg-master-latest-win64-gpl-shared', 'bin');
}

// ---- Proxy server (NetEase API on port 4000) ----

function startProxyServer() {
  const root = getProjectRoot();
  logToFile('Proxy: root=' + root);
  logToFile('Proxy: __dirname=' + __dirname);

  // Require NeteaseCloudMusicApi from node_modules in app directory
  let ncm;
  try {
    const ncmPath = path.join(root, 'node_modules', 'NeteaseCloudMusicApi');
    logToFile('Proxy: requiring NeteaseCloudMusicApi from ' + ncmPath);
    logToFile('Proxy: main.js exists=' + fs.existsSync(path.join(ncmPath, 'main.js')));
    ncm = require(ncmPath);
    logToFile('Proxy: module loaded, keys=' + Object.keys(ncm).length);
  } catch (err) {
    logToFile('Proxy: FAILED to load NeteaseCloudMusicApi: ' + err.message);
    logToFile('Proxy: stack=' + err.stack);
    return null;
  }
  const {
    login_qr_key, login_qr_create, login_qr_check, login_status,
    user_playlist, playlist_detail, song_url_v1, song_detail, logout
  } = ncm;

  const PORT = 4000;
  const APPDATA = process.env.APPDATA || '';
  const COOKIE_DIR = APPDATA ? path.join(APPDATA, 'ilya', 'data') : path.join(root, 'data');
  const COOKIE_FILE = path.join(COOKIE_DIR, 'netease_node_cookies.json');

  function loadCookies() {
    try { return JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf-8')); }
    catch { return ''; }
  }
  function saveCookies(c) {
    try {
      fs.mkdirSync(COOKIE_DIR, { recursive: true });
      fs.writeFileSync(COOKIE_FILE, JSON.stringify(c));
    } catch {}
  }

  let cookie = loadCookies();

  function sendJSON(res, code, data) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  }

  function extractCookie(result) {
    if (!result.cookie) return;
    let raw;
    if (Array.isArray(result.cookie)) {
      raw = result.cookie.join('; ');
    } else if (typeof result.cookie === 'object') {
      raw = Object.entries(result.cookie).map(([k, v]) => `${k}=${v}`).join('; ');
    } else {
      raw = String(result.cookie);
    }
    const pairs = [];
    const seen = new Set();
    raw.split(';').forEach(part => {
      part = part.trim();
      if (!part || !part.includes('=')) return;
      const key = part.split('=')[0].trim();
      if (!key || seen.has(key)) return;
      const skip = ['Max-Age', 'Expires', 'Path', 'Domain', 'SameSite', 'Secure', 'HttpOnly'];
      if (skip.includes(key)) return;
      seen.add(key);
      pairs.push(part);
    });
    if (pairs.length > 0) {
      cookie = pairs.join('; ');
      saveCookies(cookie);
    }
  }

  async function handleRequest(req, res) {
    const parsed = url.parse(req.url, true);
    const reqPath = parsed.pathname;
    const query = parsed.query;

    let body = '';
    await new Promise(resolve => {
      req.on('data', chunk => body += chunk);
      req.on('end', resolve);
    });
    let postBody = {};
    try { postBody = JSON.parse(body); } catch {}

    try {
      if (reqPath === '/qr/key' && req.method === 'POST') {
        const result = await login_qr_key({ cookie });
        extractCookie(result);
        const unikey = result.body?.data?.unikey || '';
        sendJSON(res, 200, { unikey });
      }
      else if (reqPath === '/qr/create' && req.method === 'POST') {
        const key = postBody.key || query.key;
        const result = await login_qr_create({ key, qrimg: true, cookie });
        extractCookie(result);
        const data = result.body?.data || {};
        sendJSON(res, 200, { qrimg: data.qrimg || '', qrurl: data.qrurl || '' });
      }
      else if (reqPath === '/qr/check' && req.method === 'POST') {
        const key = postBody.key || query.key;
        const result = await login_qr_check({ key, cookie });
        extractCookie(result);
        const code = result.body?.code || result.code || -1;
        const message = result.body?.message || '';
        sendJSON(res, 200, { code, message, cookie_saved: !!cookie });
      }
      else if (reqPath === '/status' && req.method === 'GET') {
        const result = await login_status({ cookie });
        extractCookie(result);
        const data = result.body?.data || result.body || {};
        const profile = data.profile;
        const account = data.account;
        if (profile && account) {
          sendJSON(res, 200, {
            logged_in: true,
            user: {
              id: profile.userId || account.id,
              nickname: profile.nickname,
              avatar: profile.avatarUrl || '',
            }
          });
        } else {
          sendJSON(res, 200, { logged_in: false });
        }
      }
      else if (reqPath === '/logout' && req.method === 'POST') {
        try { await logout({ cookie }); } catch {}
        cookie = '';
        saveCookies(cookie);
        sendJSON(res, 200, { code: 200 });
      }
      else if (reqPath === '/playlists' && req.method === 'GET') {
        const uid = query.uid;
        const result = await user_playlist({ uid, limit: 200, cookie });
        extractCookie(result);
        const playlists = (result.body?.playlist || []).map(p => ({
          id: p.id,
          name: p.name,
          cover: p.coverImgUrl,
          track_count: p.trackCount,
          creator: p.creator?.nickname || '',
          is_own: p.creator?.userId === parseInt(uid),
        }));
        sendJSON(res, 200, { playlists });
      }
      else if (reqPath === '/playlist/detail' && req.method === 'GET') {
        const id = query.id;
        const result = await playlist_detail({ id, n: 100000, cookie });
        extractCookie(result);
        const trackIds = result.body?.playlist?.trackIds || [];
        const ids = trackIds.slice(0, 500).map(t => t.id);
        let tracks = [];
        if (ids.length > 0) {
          const detail = await song_detail({ ids: ids.join(','), cookie });
          extractCookie(detail);
          tracks = (detail.body?.songs || []).map(s => ({
            id: s.id,
            name: s.name,
            artist: (s.ar || []).map(a => a.name).join(' / '),
            album: s.al?.name || '',
            cover: s.al?.picUrl || '',
            duration: Math.floor((s.dt || 0) / 1000),
          }));
        }
        sendJSON(res, 200, { tracks });
      }
      else if (reqPath === '/song/url' && req.method === 'GET') {
        const id = query.id;
        const result = await song_url_v1({ id, level: 'exhigh', cookie });
        extractCookie(result);
        const songUrl = result.body?.data?.[0]?.url || '';
        sendJSON(res, 200, { url: songUrl });
      }
      else {
        sendJSON(res, 404, { error: 'not found: ' + reqPath });
      }
    } catch (err) {
      console.error('[proxy] Error:', err.message);
      sendJSON(res, 500, { error: err.message });
    }
  }

  const server = http.createServer(handleRequest);
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`[proxy] Port ${PORT} already in use — skipping proxy server (another instance may be running)`);
    } else {
      console.error('[proxy] Server error:', err.message);
    }
  });
  server.listen(PORT, () => {
    console.log(`[proxy] NetEase API proxy running on http://127.0.0.1:${PORT}`);
    console.log(`[proxy] Cookie loaded: ${cookie ? 'yes (' + cookie.length + ' chars)' : 'no'}`);
  });

  return server;
}

// ---- Python backend ----

function startPythonServer() {
  const pythonExe = getPythonExe();
  const root = getProjectRoot();
  const ffmpegBin = getFFmpegPath();

  // Set PATH for FFmpeg DLLs; PROXY_BY_ELECTRON tells run.py to skip starting proxy
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

// Wait for a URL to respond
function waitForServer(url, maxRetries = 60, interval = 500) {
  return new Promise((resolve, reject) => {
    let retries = 0;
    function check() {
      const req = http.get(url, (res) => {
        if (res.statusCode === 200 || res.statusCode === 404) {
          resolve();
        } else {
          retry();
        }
        res.resume();
      });
      req.on('error', () => retry());
      req.setTimeout(2000, () => { req.destroy(); retry(); });
    }
    function retry() {
      retries++;
      if (retries >= maxRetries) {
        reject(new Error('Server at ' + url + ' did not start in time'));
      } else {
        setTimeout(check, interval);
      }
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

  // Load the Flask app
  mainWindow.loadURL('http://127.0.0.1:5000');

  // Open external links in the default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http') && !url.startsWith('http://127.0.0.1')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---- App lifecycle ----

app.whenReady().then(async () => {
  logToFile('=== App starting ===');
  logToFile('execPath=' + process.execPath);
  logToFile('resourcesPath=' + (process.resourcesPath || 'N/A'));
  logToFile('cwd=' + process.cwd());

  // Start proxy server (NetEase API on port 4000) — inline in main process
  try {
    startProxyServer();
    logToFile('Proxy server started');
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

app.on('window-all-closed', () => {
  cleanup();
  app.quit();
});

app.on('before-quit', () => {
  cleanup();
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

function cleanup() {
  if (pythonProcess) {
    try { pythonProcess.kill('SIGTERM'); } catch {}
    pythonProcess = null;
  }
}

// Ensure cleanup on process exit
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(); });
process.on('SIGTERM', () => { cleanup(); process.exit(); });
