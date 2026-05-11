const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

// rooms: { roomCode: { host: ws, guest: ws } }
const rooms = {};

function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      switch (msg.type) {
        case 'create': {
          const code = generateCode();
          rooms[code] = { host: ws, guest: null };
          ws.roomCode = code;
          ws.role = 'host';
          ws.send(JSON.stringify({ type: 'created', code }));
          break;
        }

        case 'join': {
          const room = rooms[msg.code];
          if (!room) {
            ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
            return;
          }
          if (room.guest) {
            ws.send(JSON.stringify({ type: 'error', message: 'Room is full' }));
            return;
          }
          room.guest = ws;
          ws.roomCode = msg.code;
          ws.role = 'guest';
          ws.send(JSON.stringify({ type: 'joined', code: msg.code }));
          // Notify host that guest joined
          room.host.send(JSON.stringify({ type: 'guest-joined' }));
          break;
        }

        // Relay signaling messages (offer, answer, ice-candidate)
        case 'offer':
        case 'answer':
        case 'ice-candidate': {
          const room = rooms[ws.roomCode];
          if (!room) return;
          const target = ws.role === 'host' ? room.guest : room.host;
          if (target && target.readyState === 1) {
            target.send(JSON.stringify(msg));
          }
          break;
        }
      }
    } catch (e) {
      console.error('WS error:', e);
    }
  });

  ws.on('close', () => {
    if (ws.roomCode && rooms[ws.roomCode]) {
      const room = rooms[ws.roomCode];
      const other = ws.role === 'host' ? room.guest : room.host;
      if (other && other.readyState === 1) {
        other.send(JSON.stringify({ type: 'peer-left' }));
      }
      delete rooms[ws.roomCode];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`WiFiDrop running on http://0.0.0.0:${PORT}`);
  console.log(`Local: http://localhost:${PORT}`);
});
