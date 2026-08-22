// lan-server.js — AirSmash LAN multiplayer server (zero dependencies).
//
// Serves the game's static files AND relays WebSocket messages between
// exactly two players on the same network. Run on one device:
//
//     node lan-server.js            # port 8000
//     node lan-server.js 8080       # custom port
//
// Then both players open the printed http://<ip>:<port> address.
// The first connection becomes Player 1 (host/simulator), the second
// Player 2 (guest). Everything else — physics, scoring, hands — stays
// in the browsers; this process only shuttles small JSON frames.

import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || process.env.PORT || 8000);
const ROOT = __dirname;
const MAX_FRAME = 256 * 1024;          // game messages are tiny; anything else is abuse

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.task': 'application/octet-stream',
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  let filePath = path.normalize(path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath));
  if (!filePath.startsWith(ROOT)) {           // path traversal guard
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.stat(filePath, (err, st) => {
    if (!err && st.isDirectory()) filePath = path.join(filePath, 'index.html');
    fs.readFile(filePath, (err2, content) => {
      if (err2) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'text/plain' });
      res.end(content);
    });
  });
});

/* ---------- Minimal WebSocket (RFC 6455) ----------
   Only what the game needs: text frames, ping/pong, close. No
   fragmentation send-side, basic reassembly receive-side. */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

function wsEncode(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

// Feed raw bytes; returns an array of decoded text messages.
function wsDecode(chunk, state) {
  const out = [];
  state.buf = state.buf && state.buf.length ? Buffer.concat([state.buf, chunk]) : chunk;

  while (true) {
    const buf = state.buf;                    // re-read: consumed below
    if (buf.length < 2) break;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < 4) break;
      len = buf.readUInt16BE(2); off = 4;
    } else if (len === 127) {
      if (buf.length < 10) break;
      len = Number(buf.readBigUInt64BE(2)); off = 10;
    }
    if (len > MAX_FRAME) { state.dead = true; break; }
    const maskLen = masked ? 4 : 0;
    if (buf.length < off + maskLen + len) break;

    let payload = buf.subarray(off + maskLen, off + maskLen + len);
    if (masked) {
      const mask = buf.subarray(off, off + 4);
      const un = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) un[i] = payload[i] ^ mask[i & 3];
      payload = un;
    }
    state.buf = buf.subarray(off + maskLen + len);

    if (opcode === 8) { state.dead = true; break; }                 // close
    if (opcode === 9) {                                             // ping → pong
      try { socket.write(wsEncodeControl(0x8a, payload)); } catch { /* ignore */ }
      continue;
    }
    if (opcode === 10) continue;                                    // pong
    if (opcode === 1 || opcode === 2 || opcode === 0) {
      if (fin) {
        const full = state.frag ? Buffer.concat([state.frag, payload]) : payload;
        state.frag = null;
        out.push(full.toString('utf8'));
      } else {
        state.frag = state.frag ? Buffer.concat([state.frag, payload]) : Buffer.from(payload);
      }
    }
  }
  return out;
}

function wsEncodeControl(opcode, payload) {
  return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
}

/* ---------- Room: exactly two peers, first = P1 ---------- */

const room = [];   // [{ socket, role, state }]

function send(conn, obj) {
  try { conn.socket.write(wsEncode(JSON.stringify(obj))); } catch { /* ignore */ }
}

function relay(from, text) {
  const other = room.find(c => c !== from);
  if (other) {
    try { other.socket.write(wsEncode(text)); } catch { /* ignore */ }
  }
}

function broadcastPeers() {
  for (const c of room) send(c, { t: 'peers', n: room.length });
}

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket') {
    socket.destroy(); return;
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`
  );

  if (room.length >= 2) {
    socket.write(wsEncode(JSON.stringify({ t: 'full' })));
    socket.end();
    return;
  }

  const conn = {
    socket,
    role: room.length === 0 ? 'p1' : 'p2',
    state: { buf: null, frag: null, dead: false },
  };
  room.push(conn);
  send(conn, { t: 'welcome', role: conn.role });
  broadcastPeers();

  socket.on('data', (chunk) => {
    try {
      for (const text of wsDecode(chunk, conn.state)) {
        if (conn.state.dead) { socket.end(); break; }
        relay(conn, text);                    // dumb relay: game logic lives in the browsers
      }
    } catch {                                 // a malformed frame must not kill the room
      socket.end();
    }
  });

  const drop = () => {
    const i = room.indexOf(conn);
    if (i >= 0) room.splice(i, 1);
    broadcastPeers();                       // survivor sees n drop to 1 (or 0)
  };
  socket.on('close', drop);
  socket.on('error', drop);
  socket.on('end', drop);
});

server.listen(PORT, () => {
  const urls = [`http://localhost:${PORT}`];
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets || []) {
      if (net.family === 'IPv4' && !net.internal) urls.push(`http://${net.address}:${PORT}`);
    }
  }
  console.log('AirSmash LAN server running.');
  console.log('Open this address on BOTH devices (same Wi-Fi):');
  for (const u of urls) console.log('  ' + u);
  console.log('First device to connect is Player 1 (host).');
});
