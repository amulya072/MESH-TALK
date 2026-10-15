// MeshTalk signaling server
//
// This server NEVER sees chat messages. Its only job is to introduce peers
// in the same room to each other so they can open a direct WebRTC
// connection. Once that connection is up, messages travel peer-to-peer
// (mesh topology) -- the internet is the "radio" instead of Bluetooth.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8787;
const PUBLIC_DIR = path.resolve(__dirname, 'public');
const MAX_ROOM_SIZE = 20; // full mesh grows as n^2, so cap it
const HEARTBEAT_MS = 30000; // keeps connections alive behind proxies (Render etc.)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

// Optional TURN relay (helps people on mobile data / strict networks).
// Set TURN_URL, TURN_USERNAME, TURN_CREDENTIAL as environment variables.
function iceConfig() {
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL.split(',').map((s) => s.trim()),
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || '',
    });
  }
  return { iceServers };
}

const server = http.createServer((req, res) => {
  let reqPath;
  try {
    reqPath = decodeURIComponent(req.url.split('?')[0]);
  } catch {
    res.writeHead(400);
    return res.end('Bad request');
  }

  if (reqPath === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  if (reqPath === '/ice-config') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(iceConfig()));
  }

  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.resolve(PUBLIC_DIR, '.' + reqPath);

  // Prevent path traversal outside the public dir
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

// rooms: Map<roomId, Map<peerId, { ws, name }>>
const rooms = new Map();

function roomPeerList(roomId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  return [...room.entries()].map(([id, p]) => ({ id, name: p.name }));
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(roomId, msg, exceptId) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const [id, peer] of room.entries()) {
    if (id !== exceptId) send(peer.ws, msg);
  }
}

wss.on('connection', (ws) => {
  let currentRoom = null;
  let peerId = null;
  ws.isAlive = true;

  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => {}); // never let a socket error crash the server

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'join') {
      if (currentRoom) return; // already joined; ignore duplicate joins
      const roomId = String(msg.room || 'lobby').trim().slice(0, 64) || 'lobby';
      const name = String(msg.name || 'anon').trim().slice(0, 32) || 'anon';

      const existing = rooms.get(roomId);
      if (existing && existing.size >= MAX_ROOM_SIZE) {
        send(ws, { type: 'error', message: `Room is full (max ${MAX_ROOM_SIZE} people).` });
        return;
      }

      peerId = crypto.randomUUID();
      currentRoom = roomId;

      if (!rooms.has(roomId)) rooms.set(roomId, new Map());
      const existingPeers = roomPeerList(roomId);

      rooms.get(roomId).set(peerId, { ws, name });

      send(ws, { type: 'welcome', peerId, room: roomId, peers: existingPeers });
      broadcast(roomId, { type: 'peer-joined', id: peerId, name }, peerId);
      return;
    }

    // Everything below just relays signaling data between two peers by id.
    // The server reads only "to"/"from" routing fields -- never message text.
    if (!currentRoom) return;

    if (msg.type === 'signal' && typeof msg.to === 'string' && msg.data && typeof msg.data === 'object') {
      const room = rooms.get(currentRoom);
      const target = room && room.get(msg.to);
      if (target) {
        send(target.ws, { type: 'signal', from: peerId, data: msg.data });
      }
    }
  });

  ws.on('close', () => {
    if (!currentRoom || !peerId) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    room.delete(peerId);
    broadcast(currentRoom, { type: 'peer-left', id: peerId }, peerId);
    if (room.size === 0) rooms.delete(currentRoom);
  });
});

// Drop dead connections and keep live ones from idling out
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`MeshTalk signaling server listening on http://localhost:${PORT}`);
});

// Clean shutdown (Render/Railway send SIGTERM on redeploy)
process.on('SIGTERM', () => {
  wss.clients.forEach((ws) => ws.close());
  server.close(() => process.exit(0));
});
