const express = require('express');
const { WebSocket, WebSocketServer } = require('ws');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const app = express();
const useHttps = process.env.HTTPS === '1';
const sslKeyPath = process.env.SSL_KEY_PATH;
const sslCertPath = process.env.SSL_CERT_PATH;

function createServer() {
  if (!useHttps) return http.createServer(app);

  if (!sslKeyPath || !sslCertPath) {
    throw new Error('HTTPS=1 requires SSL_KEY_PATH and SSL_CERT_PATH');
  }

  return https.createServer({
    key: fs.readFileSync(sslKeyPath),
    cert: fs.readFileSync(sslCertPath),
  }, app);
}

const server = createServer();
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/qrcode-generator', express.static(path.join(__dirname, 'node_modules/qrcode-generator/dist')));
app.use('/vendor/jsqr', express.static(path.join(__dirname, 'node_modules/jsqr/dist')));

// rooms: { roomCode: { host: ws, guest: ws, createdAt: number, emptySince: number|null } }
const rooms = {};
const ROOM_TTL_MS = 30 * 60 * 1000;
const EMPTY_ROOM_TTL_MS = 2 * 60 * 1000;
const HEARTBEAT_MS = 30000;

function generateCode() {
  let code;
  do {
    code = Math.random().toString(36).substring(2, 8).toUpperCase();
  } while (rooms[code]);
  return code;
}

function send(ws, message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function getOtherPeer(ws) {
  const room = rooms[ws.roomCode];
  if (!room) return null;
  return ws.role === 'host' ? room.guest : room.host;
}

function cleanupRoom(code) {
  const room = rooms[code];
  if (!room) return;

  if (room.host && room.host.readyState === WebSocket.OPEN) {
    send(room.host, { type: 'room-closed' });
  }
  if (room.guest && room.guest.readyState === WebSocket.OPEN) {
    send(room.guest, { type: 'room-closed' });
  }

  delete rooms[code];
}

function handleClose(ws) {
  if (!ws.roomCode || !rooms[ws.roomCode]) return;

  const room = rooms[ws.roomCode];
  const other = getOtherPeer(ws);

  if (ws.role === 'host') {
    send(other, { type: 'peer-left', recoverable: false });
    cleanupRoom(ws.roomCode);
    return;
  }

  if (ws.role === 'guest') {
    room.guest = null;
    room.emptySince = Date.now();
    send(other, { type: 'peer-left', recoverable: true });
  }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      switch (msg.type) {
        case 'ping':
          send(ws, { type: 'pong', at: Date.now() });
          break;

        case 'create': {
          const code = generateCode();
          rooms[code] = { host: ws, guest: null, createdAt: Date.now(), emptySince: Date.now() };
          ws.roomCode = code;
          ws.role = 'host';
          send(ws, { type: 'created', code });
          break;
        }

        case 'join': {
          const code = String(msg.code || '').trim().toUpperCase();
          const room = rooms[code];
          if (!room) {
            send(ws, { type: 'error', message: 'Room not found' });
            return;
          }
          if (!room.host || room.host.readyState !== WebSocket.OPEN) {
            delete rooms[code];
            send(ws, { type: 'error', message: 'Room host is no longer available' });
            return;
          }
          if (room.guest && room.guest.readyState === WebSocket.OPEN) {
            send(ws, { type: 'error', message: 'Room is full' });
            return;
          }
          room.guest = ws;
          room.emptySince = null;
          ws.roomCode = code;
          ws.role = 'guest';
          send(ws, { type: 'joined', code });
          send(room.host, { type: 'guest-joined' });
          break;
        }

        // Relay signaling messages (offer, answer, ice-candidate)
        case 'offer':
        case 'answer':
        case 'ice-candidate': {
          const room = rooms[ws.roomCode];
          if (!room) return;
          const target = ws.role === 'host' ? room.guest : room.host;
          send(target, msg);
          break;
        }
      }
    } catch (e) {
      console.error('WS error:', e);
    }
  });

  ws.on('close', () => handleClose(ws));
});

setInterval(() => {
  const now = Date.now();

  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });

  Object.entries(rooms).forEach(([code, room]) => {
    const hostGone = !room.host || room.host.readyState !== WebSocket.OPEN;
    const expired = now - room.createdAt > ROOM_TTL_MS;
    const emptyExpired = room.emptySince && now - room.emptySince > EMPTY_ROOM_TTL_MS;

    if (hostGone || expired || emptyExpired) {
      cleanupRoom(code);
    }
  });
}, HEARTBEAT_MS);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  const protocol = useHttps ? 'https' : 'http';
  console.log(`WiFiDrop running on ${protocol}://0.0.0.0:${PORT}`);
  console.log(`Local: ${protocol}://localhost:${PORT}`);
});
