// ============================================================
// SecureApp — Screen Relay Server v1.0
// 
// Yeh server agent aur admin ke beech bridge hai
// Deploy karo: Render.com / Railway / Glitch (free tier works)
//
// Render.com pe deploy karne ke steps:
// 1. GitHub pe push karo
// 2. render.com → New Web Service → GitHub repo select
// 3. Build Command: npm install
// 4. Start Command: node screen-relay-server.js
// 5. Free plan: web service
// 6. Deploy karo → URL milega (wss://your-app.onrender.com)
// 7. screen-agent.js mein RELAY_SERVER = us URL se update karo
// 8. main.js mein RELAY_SERVER = same URL
//
// PACKAGE.JSON for relay server:
// { "dependencies": { "ws": "^8.16.0" } }
// ============================================================

'use strict';

const http      = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;

// ── State ────────────────────────────────────────────────
// agents: username → { ws, deviceId, hostname, os, lastSeen, watching:Set<adminWs> }
// admins: ws → { type:'admin' }
const agents = {}; // key: username
const admins = new Set();

// ── HTTP server (health check ke liye) ─────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      agents: Object.keys(agents).length,
      admins: admins.size,
      uptime: process.uptime()
    }));
    return;
  }
  res.writeHead(200);
  res.end('AQ Screen Relay v1.0');
});

const wss = new WebSocket.Server({ server });

function sendSafe(ws, data) {
  try {
    if (ws.readyState === WebSocket.OPEN)
      ws.send(typeof data === 'string' ? data : JSON.stringify(data));
  } catch {}
}

function broadcastAgentList(toWs) {
  const list = Object.entries(agents).map(([u, a]) => ({
    username: u,
    deviceId: a.deviceId,
    hostname: a.hostname,
    os:       a.os,
    online:   a.ws && a.ws.readyState === WebSocket.OPEN,
    lastSeen: a.lastSeen
  }));
  const msg = JSON.stringify({ type: 'agents', list });
  if (toWs) {
    sendSafe(toWs, msg);
  } else {
    // sab admins ko bhejo
    admins.forEach(w => sendSafe(w, msg));
  }
}

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log('[Relay] New connection from:', ip);
  let role = null;     // 'agent' ya 'admin'
  let myUsername = null;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // ── AGENT REGISTER ──────────────────────────────────
    if (msg.type === 'register') {
      role       = 'agent';
      myUsername = (msg.username || '').toLowerCase();
      agents[myUsername] = {
        ws,
        deviceId: msg.deviceId || '',
        hostname: msg.hostname || 'Unknown',
        os:       msg.os || 'Unknown',
        lastSeen: Date.now(),
        watching: new Set()
      };
      console.log('[Relay] Agent registered:', myUsername, msg.deviceId);
      // Sab admins ko updated list do
      broadcastAgentList(null);
      return;
    }

    // ── FRAME FROM AGENT ────────────────────────────────
    if (msg.type === 'frame') {
      const uname = (msg.username || '').toLowerCase();
      const agent = agents[uname];
      if (!agent) return;
      agent.lastSeen = Date.now();
      // Forward to all watching admins
      const fwd = JSON.stringify(msg);
      agent.watching.forEach(adminWs => sendSafe(adminWs, fwd));
      return;
    }

    // ── PONG FROM AGENT ─────────────────────────────────
    if (msg.type === 'pong') {
      const uname = (msg.username || '').toLowerCase();
      if (agents[uname]) agents[uname].lastSeen = Date.now();
      return;
    }

    // ── ADMIN CONNECT ───────────────────────────────────
    if (msg.type === 'admin-connect') {
      role = 'admin';
      admins.add(ws);
      console.log('[Relay] Admin connected');
      // Online agents ki list bhejo
      broadcastAgentList(ws);
      return;
    }

    // ── ADMIN WATCH (start watching a user) ─────────────
    if (msg.type === 'watch') {
      const uname  = (msg.username || '').toLowerCase();
      const agent  = agents[uname];
      if (!agent) {
        sendSafe(ws, JSON.stringify({ type: 'error', message: 'Agent offline' }));
        return;
      }
      // Un-watch previous agar tha
      Object.values(agents).forEach(a => a.watching.delete(ws));
      // Watch this agent
      agent.watching.add(ws);
      console.log('[Relay] Admin watching:', uname);
      // Agent ko capture shuru karne ka signal
      sendSafe(agent.ws, JSON.stringify({ type: 'capture-start' }));
      sendSafe(ws, JSON.stringify({ type: 'watch-started', username: uname }));
      return;
    }

    // ── ADMIN UN-WATCH ───────────────────────────────────
    if (msg.type === 'unwatch') {
      const uname = (msg.username || '').toLowerCase();
      const agent = agents[uname];
      if (agent) {
        agent.watching.delete(ws);
        // Agar koi aur admin nahi dekh raha to capture band karo
        if (agent.watching.size === 0) {
          sendSafe(agent.ws, JSON.stringify({ type: 'capture-stop' }));
        }
      }
      return;
    }

    // ── GET AGENTS LIST ──────────────────────────────────
    if (msg.type === 'get-agents') {
      broadcastAgentList(ws);
      return;
    }
  });

  ws.on('close', () => {
    if (role === 'agent' && myUsername) {
      console.log('[Relay] Agent disconnected:', myUsername);
      // Admin ko notify karo
      broadcastAgentList(null);
      // Watching admins ko bhi
      if (agents[myUsername]) {
        agents[myUsername].watching.forEach(adminWs =>
          sendSafe(adminWs, JSON.stringify({ type: 'agent-offline', username: myUsername }))
        );
        delete agents[myUsername];
      }
    } else if (role === 'admin') {
      console.log('[Relay] Admin disconnected');
      admins.delete(ws);
      // Jis bhi agent ko yeh admin dekh raha tha us se stop karo
      Object.values(agents).forEach(a => {
        if (a.watching.has(ws)) {
          a.watching.delete(ws);
          if (a.watching.size === 0)
            sendSafe(a.ws, JSON.stringify({ type: 'capture-stop' }));
        }
      });
    }
  });

  ws.on('error', err => {
    console.error('[Relay] WS error:', err.message);
  });
});

// ── Ping agents periodically ─────────────────────────────
setInterval(() => {
  const now = Date.now();
  Object.entries(agents).forEach(([uname, agent]) => {
    if (agent.ws && agent.ws.readyState === WebSocket.OPEN) {
      sendSafe(agent.ws, JSON.stringify({ type: 'ping' }));
    } else if (now - agent.lastSeen > 60000) {
      // 1 min se zyada inactive → remove
      delete agents[uname];
      broadcastAgentList(null);
    }
  });
}, 20000);

server.listen(PORT, () => {
  console.log('[Relay] AQ Screen Relay Server started on port', PORT);
  console.log('[Relay] Health check: http://localhost:' + PORT + '/health');
});
