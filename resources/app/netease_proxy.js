/**
 * NeteaseCloudMusicApi proxy server.
 * Runs on port 4000, provides clean JSON endpoints for the Flask backend.
 *
 * Cookie handling: NeteaseCloudMusicApi returns cookie as an array of
 * Set-Cookie strings. We convert to a simple key=value string for storage
 * and pass it back as a string (the library accepts string cookies).
 */
const { login_qr_key, login_qr_create, login_qr_check, login_status, 
        user_playlist, playlist_detail, song_url_v1, song_detail, logout } = require('NeteaseCloudMusicApi');

const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');

const PORT = 4000;

// Use AppData for cookie persistence in packaged mode
const APPDATA = process.env.APPDATA || '';
const COOKIE_DIR = APPDATA ? path.join(APPDATA, 'ilya', 'data') : path.join(__dirname, 'data');
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
    // cookieToJson format: { key: value, ... }
    raw = Object.entries(result.cookie).map(([k, v]) => `${k}=${v}`).join('; ');
  } else {
    raw = String(result.cookie);
  }
  // Parse all key=value pairs from the raw cookie string
  const newPairs = new Map();
  raw.split(';').forEach(part => {
    part = part.trim();
    if (!part || !part.includes('=')) return;
    const eqIdx = part.indexOf('=');
    const key = part.substring(0, eqIdx).trim();
    if (!key) return;
    // Skip Set-Cookie attributes
    const skip = ['Max-Age', 'Expires', 'Path', 'Domain', 'SameSite', 'Secure', 'HttpOnly'];
    if (skip.includes(key)) return;
    newPairs.set(key, part);
  });
  if (newPairs.size === 0) return;

  // Merge with existing cookies: new values override old ones,
  // but existing keys not present in the new response are preserved.
  const existing = new Map();
  if (cookie) {
    cookie.split(';').forEach(part => {
      part = part.trim();
      if (!part || !part.includes('=')) return;
      const eqIdx = part.indexOf('=');
      const key = part.substring(0, eqIdx).trim();
      if (key) existing.set(key, part);
    });
  }
  for (const [key, pair] of newPairs) {
    existing.set(key, pair);
  }
  const merged = Array.from(existing.values()).join('; ');
  if (merged !== cookie) {
    cookie = merged;
    saveCookies(cookie);
  }
}

async function handleRequest(req, res) {
  const parsed = url.parse(req.url, true);
  const path = parsed.pathname;
  const query = parsed.query;

  let body = '';
  await new Promise(resolve => {
    req.on('data', chunk => body += chunk);
    req.on('end', resolve);
  });
  let postBody = {};
  try { postBody = JSON.parse(body); } catch {}

  try {
    if (path === '/qr/key' && req.method === 'POST') {
      const result = await login_qr_key({ cookie });
      extractCookie(result);
      const unikey = result.body?.data?.unikey || '';
      sendJSON(res, 200, { unikey });
    }
    else if (path === '/qr/create' && req.method === 'POST') {
      const key = postBody.key || query.key;
      const result = await login_qr_create({ key, qrimg: true, cookie });
      extractCookie(result);
      const data = result.body?.data || {};
      sendJSON(res, 200, { qrimg: data.qrimg || '', qrurl: data.qrurl || '' });
    }
    else if (path === '/qr/check' && req.method === 'POST') {
      const key = postBody.key || query.key;
      const result = await login_qr_check({ key, cookie });
      extractCookie(result);
      const code = result.body?.code || result.code || -1;
      const message = result.body?.message || '';
      sendJSON(res, 200, { code, message, cookie_saved: !!cookie });
    }
    else if (path === '/status' && req.method === 'GET') {
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
    else if (path === '/logout' && req.method === 'POST') {
      try { await logout({ cookie }); } catch {}
      cookie = '';
      saveCookies(cookie);
      sendJSON(res, 200, { code: 200 });
    }
    else if (path === '/playlists' && req.method === 'GET') {
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
    else if (path === '/playlist/detail' && req.method === 'GET') {
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
    else if (path === '/song/url' && req.method === 'GET') {
      const id = query.id;
      const result = await song_url_v1({ id, level: 'exhigh', cookie });
      extractCookie(result);
      const url = result.body?.data?.[0]?.url || '';
      sendJSON(res, 200, { url });
    }
    else {
      sendJSON(res, 404, { error: 'not found: ' + path });
    }
  } catch (err) {
    console.error('Error:', err.message);
    sendJSON(res, 500, { error: err.message });
  }
}

const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  console.log(`NetEase API proxy running on http://127.0.0.1:${PORT}`);
  console.log(`Cookie loaded: ${cookie ? 'yes (' + cookie.length + ' chars)' : 'no'}`);
});
