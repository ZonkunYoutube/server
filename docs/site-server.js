const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8124);
const ROOT = __dirname;
const STATE_FILE = path.join(ROOT, 'player-state.json');
const ROOM_STATE_FILE = path.join(ROOT, 'room-state.json');
const AUTH_STATE_FILE = path.join(ROOT, 'auth-state.json');
const ROOM_JOIN_FILE = path.join(ROOT, 'room-join-state.json');
const CHAT_STATE_FILE = path.join(ROOT, 'chat-state.json');
const INGEST_KEY = String(process.env.INGEST_KEY || process.env.pass || 'zon_2026_secret_7aX9LpQ2m').trim();
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS || 180000);
const AUTH_TTL_MS = Number(process.env.AUTH_TTL_MS || 180000);
const AUTH_COOLDOWN_MS = Number(process.env.AUTH_COOLDOWN_MS || 60000);
const PLAYER_STATE_TTL_MS = Number(process.env.PLAYER_STATE_TTL_MS || 180000);
const AUTH_LOBBY_FRESH_MS = Number(process.env.AUTH_LOBBY_FRESH_MS || 20000);
const ROOM_JOIN_TTL_MS = Number(process.env.ROOM_JOIN_TTL_MS || 180000);
const CHAT_HISTORY_MAX = Number(process.env.CHAT_HISTORY_MAX || 400);
const CHAT_MESSAGE_MAX = Number(process.env.CHAT_MESSAGE_MAX || 220);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ogg': 'audio/ogg',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf'
};

const state = loadState();
const roomState = loadRoomState();
const authState = loadAuthState();
const roomJoinState = loadRoomJoinState();
const chatState = loadChatState();

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : { servers: {} };
  } catch {
    return { servers: {} };
  }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.warn('[bridge] failed to save state:', err.message || err);
  }
}

function loadRoomState() {
  try {
    const raw = fs.readFileSync(ROOM_STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : { servers: {} };
  } catch {
    return { servers: {} };
  }
}

function saveRoomState() {
  try {
    fs.writeFileSync(ROOM_STATE_FILE, JSON.stringify(roomState, null, 2), 'utf8');
  } catch (err) {
    console.warn('[bridge] failed to save room state:', err.message || err);
  }
}

function loadAuthState() {
  try {
    const raw = fs.readFileSync(AUTH_STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { challenges: {}, sessions: {} };
    if (!parsed.challenges || typeof parsed.challenges !== 'object') parsed.challenges = {};
    if (!parsed.sessions || typeof parsed.sessions !== 'object') parsed.sessions = {};
    return parsed;
  } catch {
    return { challenges: {}, sessions: {} };
  }
}

function saveAuthState() {
  try {
    fs.writeFileSync(AUTH_STATE_FILE, JSON.stringify(authState, null, 2), 'utf8');
  } catch (err) {
    console.warn('[bridge] failed to save auth state:', err.message || err);
  }
}

function loadRoomJoinState() {
  try {
    const raw = fs.readFileSync(ROOM_JOIN_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { pendingByGamertag: {} };
    if (!parsed.pendingByGamertag || typeof parsed.pendingByGamertag !== 'object') parsed.pendingByGamertag = {};
    return parsed;
  } catch {
    return { pendingByGamertag: {} };
  }
}

function saveRoomJoinState() {
  try {
    fs.writeFileSync(ROOM_JOIN_FILE, JSON.stringify(roomJoinState, null, 2), 'utf8');
  } catch (err) {
    console.warn('[bridge] failed to save room join state:', err.message || err);
  }
}

function loadChatState() {
  try {
    const raw = fs.readFileSync(CHAT_STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { history: [], outboxByServer: {} };
    if (!Array.isArray(parsed.history)) parsed.history = [];
    if (!parsed.outboxByServer || typeof parsed.outboxByServer !== 'object') parsed.outboxByServer = {};
    return parsed;
  } catch {
    return { history: [], outboxByServer: {} };
  }
}

function saveChatState() {
  try {
    fs.writeFileSync(CHAT_STATE_FILE, JSON.stringify(chatState, null, 2), 'utf8');
  } catch (err) {
    console.warn('[bridge] failed to save chat state:', err.message || err);
  }
}

function ensureChatOutbox(server) {
  if (!Array.isArray(chatState.outboxByServer[server])) chatState.outboxByServer[server] = [];
  return chatState.outboxByServer[server];
}

function sanitizeChatText(input) {
  const raw = String(input || '');
  const cleaned = raw.replace(/\r/g, '').replace(/\n/g, ' ').trim();
  return cleaned.length > CHAT_MESSAGE_MAX ? cleaned.slice(0, CHAT_MESSAGE_MAX) : cleaned;
}

function addChatHistory(entry) {
  chatState.history.push(entry);
  if (chatState.history.length > CHAT_HISTORY_MAX) {
    chatState.history = chatState.history.slice(chatState.history.length - CHAT_HISTORY_MAX);
  }
}

function createChatId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function isKnownServerName(name) {
  return ['lobby', 'survival', 'normal-survival', 'room'].includes(String(name || '').trim().toLowerCase());
}

function cleanupRoomJoinState() {
  const now = Date.now();
  for (const [key, pending] of Object.entries(roomJoinState.pendingByGamertag || {})) {
    const expires = Date.parse(String(pending?.expiresAt || ''));
    if (!Number.isFinite(expires) || now > expires || pending?.status === 'completed') {
      delete roomJoinState.pendingByGamertag[key];
    }
  }
}

function getSessionByToken(token) {
  const sess = authState.sessions?.[token];
  if (!sess) return null;
  const expires = Date.parse(String(sess.expiresAt || ''));
  if (sess.revokedAt || !Number.isFinite(expires) || Date.now() > expires) return null;
  return sess;
}

function getRoomByIdOrAddress(serverName, roomId, address) {
  const payload = roomState.servers?.[serverName];
  const rooms = Array.isArray(payload?.rooms) ? payload.rooms : [];
  const normalizedAddress = String(address || '').trim().toLowerCase();
  for (const room of rooms) {
    const rid = Number.isFinite(room?.roomId) ? room.roomId : null;
    const raddr = String(room?.address || '').trim().toLowerCase();
    if (roomId != null && rid === roomId) return room;
    if (normalizedAddress && raddr && raddr === normalizedAddress) return room;
  }
  return null;
}

function randomToken(len) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function normalizeName(name) {
  return String(name || '').trim();
}

function normalizeGamertagKey(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/^\.+/, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pruneAuthState() {
  const now = Date.now();
  for (const [id, challenge] of Object.entries(authState.challenges || {})) {
    const expires = Date.parse(String(challenge?.expiresAt || ''));
    if (!Number.isFinite(expires) || now > expires + 24 * 60 * 60 * 1000) {
      delete authState.challenges[id];
    }
  }
  for (const [token, sess] of Object.entries(authState.sessions || {})) {
    const expires = Date.parse(String(sess?.expiresAt || ''));
    if (!Number.isFinite(expires) || now > expires || sess?.revokedAt) {
      delete authState.sessions[token];
    }
  }
}

function createChallenge(gamertag) {
  pruneAuthState();
  const now = Date.now();
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const code = randomToken(6);
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + AUTH_TTL_MS).toISOString();

  const targetKey = normalizeGamertagKey(gamertag);
  for (const [cid, ch] of Object.entries(authState.challenges)) {
    if (normalizeGamertagKey(ch?.gamertag || '') === targetKey && !ch?.verifiedAt) {
      delete authState.challenges[cid];
    }
  }

  authState.challenges[id] = { id, gamertag, code, createdAt, expiresAt, verifiedAt: null, sessionToken: null };
  saveAuthState();
  return { id, code, expiresAt };
}

function getLastIssueAtForGamertag(gamertag) {
  let latest = 0;
  const target = normalizeGamertagKey(gamertag);
  for (const ch of Object.values(authState.challenges || {})) {
    if (!ch) continue;
    if (normalizeGamertagKey(ch.gamertag || '') !== target) continue;
    const t = Date.parse(String(ch.createdAt || ''));
    if (Number.isFinite(t) && t > latest) latest = t;
  }
  return latest;
}

function isPlayerCurrentlyOnline(gamertag) {
  const target = normalizeGamertagKey(gamertag);
  if (!target) return false;
  const now = Date.now();
  for (const payload of Object.values(state.servers || {})) {
    if (!payload || !Array.isArray(payload.players)) continue;
    const updated = Date.parse(String(payload.updatedAt || ''));
    if (!Number.isFinite(updated) || now - updated > PLAYER_STATE_TTL_MS) continue;
    for (const name of payload.players) {
      if (normalizeGamertagKey(name || '') === target) return true;
    }
  }
  return false;
}

function isPlayerOnlineInServer(gamertag, serverName) {
  const target = normalizeGamertagKey(gamertag);
  const key = String(serverName || '').trim().toLowerCase();
  if (!target || !key) return false;
  const payload = state.servers?.[key];
  if (!payload || !Array.isArray(payload.players)) return false;
  const now = Date.now();
  const updated = Date.parse(String(payload.updatedAt || ''));
  if (!Number.isFinite(updated) || now - updated > PLAYER_STATE_TTL_MS) return false;
  for (const name of payload.players) {
    if (normalizeGamertagKey(name || '') === target) return true;
  }
  return false;
}

function findOnlinePlayerDisplayNameInServer(gamertag, serverName, freshnessMs) {
  const target = normalizeGamertagKey(gamertag);
  const key = String(serverName || '').trim().toLowerCase();
  if (!target || !key) return null;
  const payload = state.servers?.[key];
  if (!payload || !Array.isArray(payload.players)) return null;
  const now = Date.now();
  const updated = Date.parse(String(payload.updatedAt || ''));
  if (!Number.isFinite(updated) || now - updated > freshnessMs) return null;
  for (const name of payload.players) {
    if (normalizeGamertagKey(name || '') === target) {
      return String(name || '').trim();
    }
  }
  return null;
}

function findOnlinePlayerDisplayName(gamertag, preferredServer) {
  const target = normalizeGamertagKey(gamertag);
  if (!target) return null;

  const tryServer = (serverKey) => {
    const payload = state.servers?.[serverKey];
    if (!payload || !Array.isArray(payload.players)) return null;
    const now = Date.now();
    const updated = Date.parse(String(payload.updatedAt || ''));
    if (!Number.isFinite(updated) || now - updated > PLAYER_STATE_TTL_MS) return null;
    for (const name of payload.players) {
      if (normalizeGamertagKey(name || '') === target) {
        return String(name || '').trim();
      }
    }
    return null;
  };

  const preferred = String(preferredServer || '').trim().toLowerCase();
  if (preferred) {
    const foundPreferred = tryServer(preferred);
    if (foundPreferred) return foundPreferred;
  }

  for (const key of ['lobby', 'survival', 'normal-survival', 'room']) {
    const found = tryServer(key);
    if (found) return found;
  }
  return null;
}

function findChallengeByGamertagAndCode(gamertag, code) {
  const now = Date.now();
  const targetKey = normalizeGamertagKey(gamertag);
  for (const ch of Object.values(authState.challenges || {})) {
    if (!ch) continue;
    if (normalizeGamertagKey(ch.gamertag || '') !== targetKey) continue;
    if (String(ch.code || '').toUpperCase() !== String(code || '').toUpperCase()) continue;
    const expires = Date.parse(String(ch.expiresAt || ''));
    if (!Number.isFinite(expires) || now > expires) return { challenge: ch, expired: true };
    return { challenge: ch, expired: false };
  }
  return { challenge: null, expired: false };
}

function verifyChallenge(challenge, serverName) {
  if (challenge.verifiedAt && challenge.sessionToken) {
    return { token: challenge.sessionToken, gamertag: challenge.gamertag };
  }
  const now = Date.now();
  const token = `${randomToken(12)}${randomToken(12)}`;
  challenge.verifiedAt = new Date(now).toISOString();
  challenge.verifiedByServer = String(serverName || '');
  challenge.sessionToken = token;
  authState.sessions[token] = {
    token,
    gamertag: challenge.gamertag,
    challengeId: challenge.id,
    createdAt: challenge.verifiedAt,
    expiresAt: new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString(),
    revokedAt: null
  };
  saveAuthState();
  return { token, gamertag: challenge.gamertag };
}

function sanitizeRoomPayload(body) {
  const server = String(body.server || '').trim();
  const rooms = Array.isArray(body.rooms)
    ? body.rooms.map((r) => ({
      roomId: Number.isFinite(r?.roomId) ? r.roomId : 0,
      name: String(r?.name || ''),
      address: String(r?.address || ''),
      owner: String(r?.owner || ''),
      onlineCount: Number.isFinite(r?.onlineCount) ? r.onlineCount : 0
    }))
    : [];
  return {
    source: 'room-plugin',
    server,
    rooms,
    updatedAt: body.updatedAt || new Date().toISOString()
  };
}

function isFresh(updatedAt) {
  const t = Date.parse(String(updatedAt || ''));
  if (!Number.isFinite(t)) return false;
  return Date.now() - t <= ROOM_TTL_MS;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,x-api-key'
  };
}

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...corsHeaders()
  });
  res.end(body);
}

function sendText(res, code, text) {
  res.writeHead(code, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...corsHeaders()
  });
  res.end(text);
}

function serveFile(reqPath, res) {
  const safePath = path.normalize(reqPath).replace(/^([.][.][/\\])+/, '');
  const filePath = path.join(ROOT, safePath === '/' ? 'index.html' : safePath.replace(/^[/\\]/, ''));

  if (!filePath.startsWith(ROOT)) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      sendText(res, 404, 'Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300'
    });

    fs.createReadStream(filePath).pipe(res);
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) {
        reject(new Error('payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function sanitizePayload(body) {
  const server = String(body.server || '').trim();
  return {
    source: 'paper-push-plugin',
    server,
    count: Number.isFinite(body.count) ? body.count : 0,
    max: Number.isFinite(body.max) ? body.max : 0,
    players: Array.isArray(body.players) ? body.players.map((n) => String(n)) : [],
    updatedAt: body.updatedAt || new Date().toISOString()
  };
}

const server = http.createServer(async (req, res) => {
  try {
    if (!req.url) {
      sendText(res, 400, 'Bad Request');
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    if (url.pathname === '/health') {
      sendJson(res, 200, { ok: true, service: 'local-player-bridge', time: new Date().toISOString() });
      return;
    }

    if (url.pathname === '/auth/challenge' && req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (e) {
        sendJson(res, 400, { ok: false, error: String(e.message || e) });
        return;
      }
      const gamertag = normalizeName(body.gamertag);
      if (!/^[A-Za-z0-9_. ]{3,20}$/.test(gamertag)) {
        sendJson(res, 400, { ok: false, error: 'invalid gamertag' });
        return;
      }

      if (!isPlayerCurrentlyOnline(gamertag)) {
        sendJson(res, 404, { ok: false, error: 'player is not currently online on the server' });
        return;
      }

      const lobbyDisplayName = findOnlinePlayerDisplayNameInServer(gamertag, 'lobby', AUTH_LOBBY_FRESH_MS);
      if (!lobbyDisplayName) {
        sendJson(res, 403, { ok: false, error: 'player must be online in lobby server' });
        return;
      }

      const inOtherServer =
        findOnlinePlayerDisplayNameInServer(gamertag, 'survival', AUTH_LOBBY_FRESH_MS) ||
        findOnlinePlayerDisplayNameInServer(gamertag, 'normal-survival', AUTH_LOBBY_FRESH_MS) ||
        findOnlinePlayerDisplayNameInServer(gamertag, 'room', AUTH_LOBBY_FRESH_MS);
      if (inOtherServer) {
        sendJson(res, 403, { ok: false, error: 'player must be in lobby only' });
        return;
      }

      const now = Date.now();
      const lastIssueAt = getLastIssueAtForGamertag(gamertag);
      if (lastIssueAt > 0 && now - lastIssueAt < AUTH_COOLDOWN_MS) {
        const retryAfterMs = AUTH_COOLDOWN_MS - (now - lastIssueAt);
        sendJson(res, 429, {
          ok: false,
          error: 'cooldown',
          retryAfterMs,
          retryAfterSec: Math.ceil(retryAfterMs / 1000)
        });
        return;
      }

      const canonicalGamertag = lobbyDisplayName;
      const challenge = createChallenge(canonicalGamertag);
      sendJson(res, 200, {
        ok: true,
        challengeId: challenge.id,
        gamertag: canonicalGamertag,
        code: challenge.code,
        expiresAt: challenge.expiresAt
      });
      return;
    }

    if (url.pathname === '/auth/verify' && req.method === 'POST') {
      const auth = String(req.headers['x-api-key'] || '').trim();
      if (!INGEST_KEY || auth !== INGEST_KEY) {
        sendJson(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch (e) {
        sendJson(res, 400, { ok: false, error: String(e.message || e) });
        return;
      }

      const gamertag = normalizeName(body.gamertag);
      const code = String(body.code || '').trim().toUpperCase();
      const serverName = String(body.server || '').trim();
      if (!gamertag || !code) {
        sendJson(res, 400, { ok: false, error: 'gamertag and code are required' });
        return;
      }

      const found = findChallengeByGamertagAndCode(gamertag, code);
      if (!found.challenge) {
        sendJson(res, 404, { ok: false, error: 'challenge not found' });
        return;
      }
      if (found.expired) {
        sendJson(res, 410, { ok: false, error: 'challenge expired' });
        return;
      }

      const verified = verifyChallenge(found.challenge, serverName);
      sendJson(res, 200, { ok: true, gamertag: verified.gamertag, token: verified.token });
      return;
    }

    if (url.pathname.startsWith('/auth/status/') && req.method === 'GET') {
      const id = decodeURIComponent(url.pathname.replace('/auth/status/', '').trim());
      if (!id) {
        sendJson(res, 400, { ok: false, error: 'challenge id missing' });
        return;
      }
      const challenge = authState.challenges[id];
      if (!challenge) {
        sendJson(res, 404, { ok: false, error: 'challenge not found' });
        return;
      }
      const expires = Date.parse(String(challenge.expiresAt || ''));
      const expired = !Number.isFinite(expires) || Date.now() > expires;
      const status = challenge.verifiedAt ? 'verified' : (expired ? 'expired' : 'pending');
      sendJson(res, 200, {
        ok: true,
        status,
        gamertag: challenge.gamertag,
        verifiedAt: challenge.verifiedAt || null,
        token: challenge.verifiedAt ? challenge.sessionToken : null,
        expiresAt: challenge.expiresAt
      });
      return;
    }

    if (url.pathname.startsWith('/auth/session/') && req.method === 'GET') {
      const token = decodeURIComponent(url.pathname.replace('/auth/session/', '').trim());
      if (!token) {
        sendJson(res, 400, { ok: false, error: 'token missing' });
        return;
      }
      const sess = authState.sessions[token];
      if (!sess) {
        sendJson(res, 404, { ok: false, error: 'not found' });
        return;
      }
      const expires = Date.parse(String(sess.expiresAt || ''));
      if (sess.revokedAt || !Number.isFinite(expires) || Date.now() > expires) {
        sendJson(res, 401, { ok: false, error: 'expired' });
        return;
      }
      sendJson(res, 200, { ok: true, gamertag: sess.gamertag, expiresAt: sess.expiresAt });
      return;
    }

    if (url.pathname === '/auth/logout' && req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (e) {
        sendJson(res, 400, { ok: false, error: String(e.message || e) });
        return;
      }
      const token = String(body.token || '').trim();
      if (!token) {
        sendJson(res, 400, { ok: false, error: 'token missing' });
        return;
      }
      const sess = authState.sessions[token];
      if (sess) {
        sess.revokedAt = new Date().toISOString();
        saveAuthState();
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (url.pathname === '/roomjoin/create' && req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (e) {
        sendJson(res, 400, { ok: false, error: String(e.message || e) });
        return;
      }

      const token = String(body.token || '').trim();
      if (!token) {
        sendJson(res, 401, { ok: false, error: 'token missing' });
        return;
      }
      const sess = getSessionByToken(token);
      if (!sess) {
        sendJson(res, 401, { ok: false, error: 'invalid session' });
        return;
      }

      const roomId = Number.isFinite(body.roomId) ? body.roomId : null;
      const address = String(body.address || '').trim().toLowerCase();
      const room = getRoomByIdOrAddress('room', roomId, address);
      if (!room) {
        sendJson(res, 404, { ok: false, error: 'room not found' });
        return;
      }

      cleanupRoomJoinState();
      const now = Date.now();
      const gamertagKey = normalizeGamertagKey(sess.gamertag || '');
      if (!gamertagKey) {
        sendJson(res, 400, { ok: false, error: 'session missing gamertag' });
        return;
      }

      roomJoinState.pendingByGamertag[gamertagKey] = {
        gamertag: sess.gamertag,
        roomId: Number.isFinite(room?.roomId) ? room.roomId : 0,
        roomName: String(room?.name || ''),
        address: String(room?.address || ''),
        owner: String(room?.owner || ''),
        status: 'pending',
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ROOM_JOIN_TTL_MS).toISOString(),
        claimedLobbyAt: null,
        claimedRoomAt: null
      };
      saveRoomJoinState();

      sendJson(res, 200, {
        ok: true,
        gamertag: sess.gamertag,
        roomId: room.roomId,
        roomName: room.name || '',
        address: room.address || '',
        expiresAt: roomJoinState.pendingByGamertag[gamertagKey].expiresAt
      });
      return;
    }

    if (url.pathname === '/roomjoin/lobby-claim' && req.method === 'GET') {
      const auth = String(req.headers['x-api-key'] || '').trim();
      if (!INGEST_KEY || auth !== INGEST_KEY) {
        sendJson(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }

      cleanupRoomJoinState();
      const gamertag = String(url.searchParams.get('gamertag') || '').trim();
      if (!gamertag) {
        sendJson(res, 400, { ok: false, error: 'gamertag missing' });
        return;
      }
      const key = normalizeGamertagKey(gamertag);
      const pending = roomJoinState.pendingByGamertag[key];
      if (!pending) {
        sendJson(res, 200, { ok: true, found: false });
        return;
      }
      if (pending.status !== 'pending' && pending.status !== 'lobby_claimed') {
        sendJson(res, 200, { ok: true, found: false });
        return;
      }
      pending.status = 'lobby_claimed';
      pending.claimedLobbyAt = new Date().toISOString();
      saveRoomJoinState();
      sendJson(res, 200, {
        ok: true,
        found: true,
        roomId: pending.roomId,
        roomName: pending.roomName,
        address: pending.address
      });
      return;
    }

    if (url.pathname === '/roomjoin/room-claim' && req.method === 'GET') {
      const auth = String(req.headers['x-api-key'] || '').trim();
      if (!INGEST_KEY || auth !== INGEST_KEY) {
        sendJson(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }

      cleanupRoomJoinState();
      const gamertag = String(url.searchParams.get('gamertag') || '').trim();
      if (!gamertag) {
        sendJson(res, 400, { ok: false, error: 'gamertag missing' });
        return;
      }
      const key = normalizeGamertagKey(gamertag);
      const pending = roomJoinState.pendingByGamertag[key];
      if (!pending) {
        sendJson(res, 200, { ok: true, found: false });
        return;
      }
      if (pending.status !== 'pending' && pending.status !== 'lobby_claimed') {
        sendJson(res, 200, { ok: true, found: false });
        return;
      }

      pending.status = 'completed';
      pending.claimedRoomAt = new Date().toISOString();
      const response = {
        ok: true,
        found: true,
        roomId: pending.roomId,
        roomName: pending.roomName,
        address: pending.address
      };
      delete roomJoinState.pendingByGamertag[key];
      saveRoomJoinState();
      sendJson(res, 200, response);
      return;
    }

    if (url.pathname === '/chat/ingest' && req.method === 'POST') {
      const auth = String(req.headers['x-api-key'] || '').trim();
      if (!INGEST_KEY || auth !== INGEST_KEY) {
        sendJson(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch (e) {
        sendJson(res, 400, { ok: false, error: String(e.message || e) });
        return;
      }
      const server = String(body.server || '').trim().toLowerCase();
      const player = String(body.player || '').trim();
      const message = sanitizeChatText(body.message);
      if (!isKnownServerName(server)) {
        sendJson(res, 400, { ok: false, error: 'invalid server' });
        return;
      }
      if (!player || !message) {
        sendJson(res, 400, { ok: false, error: 'player and message are required' });
        return;
      }

      addChatHistory({
        id: createChatId(),
        server,
        from: player,
        message,
        source: 'minecraft',
        at: new Date().toISOString()
      });
      saveChatState();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (url.pathname === '/chat/list' && req.method === 'GET') {
      const token = String(url.searchParams.get('token') || '').trim();
      const sess = getSessionByToken(token);
      if (!sess) {
        sendJson(res, 401, { ok: false, error: 'invalid session' });
        return;
      }
      const server = String(url.searchParams.get('server') || 'all').trim().toLowerCase();
      const limitRaw = Number(url.searchParams.get('limit') || 80);
      const limit = Number.isFinite(limitRaw) ? Math.max(10, Math.min(200, Math.floor(limitRaw))) : 80;

      let items = chatState.history;
      if (server !== 'all') {
        items = items.filter((it) => String(it.server || '').toLowerCase() === server);
      }
      const messages = items.slice(-limit);
      sendJson(res, 200, { ok: true, messages });
      return;
    }

    if (url.pathname === '/chat/send' && req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (e) {
        sendJson(res, 400, { ok: false, error: String(e.message || e) });
        return;
      }
      const token = String(body.token || '').trim();
      const sess = getSessionByToken(token);
      if (!sess) {
        sendJson(res, 401, { ok: false, error: 'invalid session' });
        return;
      }
      const text = sanitizeChatText(body.message);
      if (!text) {
        sendJson(res, 400, { ok: false, error: 'message is required' });
        return;
      }
      const target = String(body.server || 'all').trim().toLowerCase();
      const targets = target === 'all'
        ? ['lobby', 'survival', 'normal-survival', 'room']
        : [target];
      if (!targets.every(isKnownServerName)) {
        sendJson(res, 400, { ok: false, error: 'invalid target server' });
        return;
      }

      const nowIso = new Date().toISOString();
      for (const s of targets) {
        const msg = {
          id: createChatId(),
          server: s,
          from: String(sess.gamertag || 'web-user'),
          message: text,
          source: 'web',
          at: nowIso
        };
        addChatHistory(msg);
        ensureChatOutbox(s).push(msg);
      }
      saveChatState();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (url.pathname === '/chat/pull-text' && req.method === 'GET') {
      const auth = String(req.headers['x-api-key'] || '').trim();
      if (!INGEST_KEY || auth !== INGEST_KEY) {
        sendJson(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      const serverName = String(url.searchParams.get('server') || '').trim().toLowerCase();
      if (!isKnownServerName(serverName)) {
        sendText(res, 400, 'invalid server');
        return;
      }
      const outbox = ensureChatOutbox(serverName);
      if (!outbox.length) {
        sendText(res, 200, '');
        return;
      }
      const lines = outbox.map((m) => {
        const id = String(m.id || '');
        const from = String(m.from || '').replace(/\|/g, '');
        const b64 = Buffer.from(String(m.message || ''), 'utf8').toString('base64');
        return `${id}|${from}|${b64}`;
      });
      chatState.outboxByServer[serverName] = [];
      saveChatState();
      sendText(res, 200, lines.join('\n'));
      return;
    }

    if (url.pathname === '/ingest' && req.method === 'POST') {
      const auth = String(req.headers['x-api-key'] || '').trim();
      if (!INGEST_KEY || auth !== INGEST_KEY) {
        sendJson(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }

      let body;
      try {
        body = await readJsonBody(req);
      } catch (e) {
        sendJson(res, 400, { ok: false, error: String(e.message || e) });
        return;
      }

      const payload = sanitizePayload(body);
      if (!payload.server) {
        sendJson(res, 400, { ok: false, error: 'server is required' });
        return;
      }

      state.servers[payload.server] = payload;
      saveState();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (url.pathname === '/rooms/ingest' && req.method === 'POST') {
      const auth = String(req.headers['x-api-key'] || '').trim();
      if (!INGEST_KEY || auth !== INGEST_KEY) {
        sendJson(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }

      let body;
      try {
        body = await readJsonBody(req);
      } catch (e) {
        sendJson(res, 400, { ok: false, error: String(e.message || e) });
        return;
      }

      const payload = sanitizeRoomPayload(body);
      if (!payload.server) {
        sendJson(res, 400, { ok: false, error: 'server is required' });
        return;
      }

      roomState.servers[payload.server] = payload;
      saveRoomState();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (url.pathname === '/players' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, servers: state.servers });
      return;
    }

    if (url.pathname.startsWith('/players/') && req.method === 'GET') {
      const key = decodeURIComponent(url.pathname.replace('/players/', '').trim());
      if (!key) {
        sendJson(res, 400, { ok: false, error: 'server missing' });
        return;
      }

      const payload = state.servers[key];
      if (!payload) {
        sendJson(res, 404, { ok: false, error: 'not found' });
        return;
      }
      sendJson(res, 200, payload);
      return;
    }

    if (url.pathname === '/rooms' && req.method === 'GET') {
      const out = {};
      for (const [name, payload] of Object.entries(roomState.servers || {})) {
        if (isFresh(payload?.updatedAt)) out[name] = payload;
      }
      sendJson(res, 200, { ok: true, servers: out });
      return;
    }

    if (url.pathname.startsWith('/rooms/') && req.method === 'GET') {
      const key = decodeURIComponent(url.pathname.replace('/rooms/', '').trim());
      if (!key) {
        sendJson(res, 400, { ok: false, error: 'server missing' });
        return;
      }
      const payload = roomState.servers[key];
      if (!payload || !isFresh(payload.updatedAt)) {
        sendJson(res, 404, { ok: false, error: 'not found' });
        return;
      }
      sendJson(res, 200, payload);
      return;
    }

    let reqPath = url.pathname;
    if (reqPath === '/') reqPath = '/index.html';
    serveFile(reqPath, res);
  } catch (err) {
    sendJson(res, 500, { ok: false, error: 'internal error', detail: String(err && err.message ? err.message : err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[bridge] running at http://${HOST}:${PORT}`);
  console.log('[bridge] endpoints: POST /ingest, POST /rooms/ingest, POST /auth/challenge, POST /auth/verify, POST /auth/logout, POST /roomjoin/create, GET /roomjoin/lobby-claim, GET /roomjoin/room-claim, POST /chat/ingest, GET /chat/list, POST /chat/send, GET /chat/pull-text, GET /auth/status/<id>, GET /auth/session/<token>, GET /players/<server>, GET /players, GET /rooms/<server>, GET /rooms, GET /health');
});
