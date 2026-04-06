const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;
const UPSTREAMS = {
  lobby: process.env.LOBBY_PLUGIN_URL || 'http://127.0.0.1:8121/players',
  survival: process.env.SURVIVAL_PLUGIN_URL || 'http://127.0.0.1:8122/players',
  'normal-survival': process.env.NORMAL_SURVIVAL_PLUGIN_URL || 'http://127.0.0.1:8123/players',
  room: process.env.ROOM_PLUGIN_URL || 'http://127.0.0.1:18124/players'
};

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

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

function serveFile(reqPath, res) {
  const safePath = path.normalize(reqPath).replace(/^([.][.][/\\])+/, '');
  const filePath = path.join(ROOT, safePath === '/' ? 'index.html' : safePath.replace(/^[/\\]/, ''));

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
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

async function proxyPlayers(upstreamUrl, res) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  try {
    const response = await fetch(upstreamUrl, { signal: controller.signal, cache: 'no-store' });
    clearTimeout(timeout);

    if (!response.ok) {
      return sendJson(res, 502, { ok: false, error: `upstream ${response.status}` });
    }

    const data = await response.json();
    return sendJson(res, 200, data);
  } catch (err) {
    clearTimeout(timeout);
    return sendJson(res, 502, { ok: false, error: 'upstream unreachable', detail: String(err.message || err) });
  }
}

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname.startsWith('/api/players/')) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      res.end();
      return;
    }

    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method Not Allowed');
      return;
    }

    const key = url.pathname.replace('/api/players/', '').trim();
    const upstream = UPSTREAMS[key];
    if (!upstream) {
      return sendJson(res, 404, { ok: false, error: 'unknown server key' });
    }

    await proxyPlayers(upstream, res);
    return;
  }

  let reqPath = url.pathname;
  if (reqPath === '/') reqPath = '/index.html';
  serveFile(reqPath, res);
});

server.listen(PORT, HOST, () => {
  console.log(`mcstatus-site server running at http://${HOST}:${PORT}`);
  console.log('proxy targets:', UPSTREAMS);
});
