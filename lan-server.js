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
function wsDecode(chunk, state, socket) {
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
let roomCode = null;   // optional 4-digit code set by the first peer; the second must match

const HEARTBEAT_MS = 15000;           // server → client ping interval
const HEARTBEAT_TIMEOUT_MS = 60000;   // drop a peer with no traffic for this long

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

function dropConn(conn) {
  const i = room.indexOf(conn);
  if (i >= 0) room.splice(i, 1);
  if (room.length === 0) roomCode = null;   // room empty → clear the locked code
  broadcastPeers();                          // survivor sees n drop to 1 (or 0)
}

// Heartbeat: ping every peer; drop anyone with no traffic for HEARTBEAT_TIMEOUT_MS.
// Keeps NAT/router mappings alive and detects silently-dead sockets — the previous
// ping/pong reply was broken because wsDecode had no `socket` in scope, so no pong
// was ever sent and there was zero connection liveness in either direction.
setInterval(() => {
  const now = Date.now();
  for (const c of room) {
    try { c.socket.write(wsEncodeControl(0x89, Buffer.alloc(0))); } catch { /* ignore */ }
    if (now - (c.state.lastSeen || 0) > HEARTBEAT_TIMEOUT_MS) {
      try { c.socket.destroy(); } catch { /* ignore */ }
      dropConn(c);
    }
  }
}, HEARTBEAT_MS);

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket') {
    socket.destroy(); return;
  }

  // Optional 4-digit room code (?code=). Backward compatible: if neither peer
  // sets a code, the room stays open. The first peer to connect locks in the
  // code; the second must match it — this closes the relay-URL hole where
  // anyone who knows the (public) relay address could join the room.
  let code = null;
  try {
    const u = new URL(req.url || '/', 'http://localhost');
    code = u.searchParams.get('code');
  } catch { /* ignore */ }

  if (room.length >= 2) {                   // third connection → room full
    socket.write(wsEncode(JSON.stringify({ t: 'full' })));
    socket.end();
    return;
  }
  if (room.length === 1 && roomCode && code !== roomCode) {
    socket.write(wsEncode(JSON.stringify({ t: 'full' })));
    socket.end();
    return;
  }

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`
  );

  if (room.length === 0 && code) roomCode = code;   // first peer locks the code

  const conn = {
    socket,
    role: room.length === 0 ? 'p1' : 'p2',
    state: { buf: null, frag: null, dead: false, lastSeen: Date.now() },
  };
  room.push(conn);
  send(conn, { t: 'welcome', role: conn.role });
  broadcastPeers();

  socket.on('data', (chunk) => {
    conn.state.lastSeen = Date.now();        // any received traffic counts as alive
    try {
      for (const text of wsDecode(chunk, conn.state, socket)) {
        if (conn.state.dead) { socket.end(); break; }
        relay(conn, text);                    // dumb relay: game logic lives in the browsers
      }
    } catch {                                 // a malformed frame must not kill the room
      socket.end();
    }
  });

  socket.on('close', () => dropConn(conn));
  socket.on('error', () => dropConn(conn));
  socket.on('end', () => dropConn(conn));
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
