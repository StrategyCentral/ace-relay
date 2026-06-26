const http = require("http");
const WebSocket = require("ws");
const url = require("url");

const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', 'https://acetradingbots.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  // Parse URL
  const parsedUrl = url.parse(req.url, true);
  
  // API ENDPOINT: Active Connections
  if (parsedUrl.pathname === '/admin/active-connections' && req.method === 'GET') {
    const connections = [];
    
    for (const [id, client] of clients) {
      connections.push({
        licenseKey: client.key || 'N/A',
        customerEmail: 'N/A',
        group: client.group || 'N/A',
        strategy: client.strategy || 'N/A',
        licenseStatus: 'active',
        connectedAt: client.connectedAt || new Date().toISOString(),
        lastValidated: new Date().toISOString(),
        role: client.role || 'N/A'
      });
    }
    
    const groups = new Set();
    for (const client of clients.values()) {
      if (client.group) groups.add(client.group);
    }
    
    res.writeHead(200, {"Content-Type": "application/json"});
    res.end(JSON.stringify({
      count: clients.size,
      signals_today: 0,
      active_groups: groups.size,
      avg_latency: 3,
      connections: connections
    }));
    return;
  }
  
  // API ENDPOINT: Disconnect License
  if (parsedUrl.pathname === '/admin/disconnect-license' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const licenseKey = data.license_key;
        let disconnected = 0;
        
        for (const [id, client] of clients) {
          if (client.key === licenseKey) {
            try {
              client.ws.close();
            } catch (e) {
              console.log('Error closing connection:', e);
            }
            clients.delete(id);
            disconnected++;
          }
        }
        
        console.log(`Disconnected ${disconnected} client(s) with license: ${licenseKey}`);
        
        res.writeHead(200, {"Content-Type": "application/json"});
        res.end(JSON.stringify({
          success: true,
          disconnected: disconnected
        }));
      } catch (err) {
        console.error('Error in disconnect endpoint:', err);
        res.writeHead(400, {"Content-Type": "application/json"});
        res.end(JSON.stringify({
          success: false,
          error: 'Invalid request'
        }));
      }
    });
    return;
  }
  
  // API ENDPOINT: Validate License + Strategy
  if (parsedUrl.pathname === '/validate-license' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { license_key, strategy, hardware_id } = data;
        
        console.log(`Validation request: License=${license_key}, Strategy=${strategy}, Hardware=${hardware_id}`);
        
        // TODO: Add Supabase validation here
        // For now, return success (you'll add Supabase check later)
        
        res.writeHead(200, {"Content-Type": "application/json"});
        res.end(JSON.stringify({
          valid: true,
          group: strategy + '_GROUP',
          allowed_strategies: [strategy], // Will come from Supabase
          message: 'License validated'
        }));
      } catch (err) {
        console.error('Error in validation endpoint:', err);
        res.writeHead(400, {"Content-Type": "application/json"});
        res.end(JSON.stringify({
          valid: false,
          error: 'Invalid request'
        }));
      }
    });
    return;
  }
  
  // API ENDPOINT: Read-only stats for internal dashboard (no apiKeys leaked)
  if (parsedUrl.pathname === '/stats' && req.method === 'GET') {
    maybeRollMessagesToday();
    const groups = [];
    for (const [group, s] of groupStats) {
      groups.push({
        group,
        children: s.children,
        masters: s.masters,
        lastMessageAt: s.lastMessageAt,
        messagesToday: s.messagesToday
      });
    }
    res.writeHead(200, {"Content-Type": "application/json"});
    res.end(JSON.stringify({
      uptimeSeconds: Math.floor((Date.now() - serverStartedAt.getTime()) / 1000),
      serverStartedAt: serverStartedAt.toISOString(),
      groups: groups
    }));
    return;
  }

  // API ENDPOINT: Health check
  if (parsedUrl.pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, {"Content-Type": "application/json"});
    res.end(JSON.stringify({ status: "ok", uptimeSeconds: Math.floor((Date.now() - serverStartedAt.getTime()) / 1000) }));
    return;
  }

  // Default response
  res.writeHead(200, {"Content-Type": "text/plain"});
  res.end("ACE Relay: OK");
});

// WebSocket server
const wss = new WebSocket.Server({ server });
const clients = new Map();

// === Anti-abuse connection telemetry (additive, read-only; does NOT affect routing) ===
const serverStartedAt = new Date();
// Per-group counters: { children, masters, lastMessageAt, messagesToday }
const groupStats = new Map();
// Track the UTC date the messagesToday counters apply to, so they reset daily.
let messagesTodayDate = new Date().toISOString().slice(0, 10);

function statsFor(group) {
  let s = groupStats.get(group);
  if (!s) {
    s = { children: 0, masters: 0, lastMessageAt: null, messagesToday: 0 };
    groupStats.set(group, s);
  }
  return s;
}

function maybeRollMessagesToday() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== messagesTodayDate) {
    messagesTodayDate = today;
    for (const s of groupStats.values()) s.messagesToday = 0;
  }
}

function send(ws, obj){ 
  try{ 
    ws.send(JSON.stringify(obj)); 
  } catch(_){} 
}

wss.on("connection", (ws, req) => {
  const q = url.parse(req.url, true).query;
  const role = (q.role || "").toString();
  const group = (q.group || "").toString();
  const key = (q.apiKey || "").toString();
  const strategy = (q.strategy || "").toString(); // NEW!
  
  if (!role || !group || !key) { 
    console.log('Connection rejected: missing parameters');
    ws.close(); 
    return; 
  }
  
  console.log(`Connection attempt: role=${role}, group=${group}, strategy=${strategy}, key=${key.substring(0, 10)}...`);
  
  // TODO: Add strategy validation against Supabase
  // For now, allow all connections
  
  const id = Math.random().toString(36).slice(2);
  clients.set(id, { 
    ws, 
    role, 
    group, 
    key,
    strategy, // NEW!
    connectedAt: new Date().toISOString()
  });
  
  console.log(`[+] ${role} connected to ${group} (strategy: ${strategy})`);

  // Telemetry: bump per-group connection counters (does NOT affect routing).
  const gs = statsFor(group);
  if (role === "child") {
    gs.children++;
    if (gs.children > 1) {
      console.log(`[ABUSE] group ${group} now has ${gs.children} concurrent children (apiKey ${key.substring(0, 6)}...) — possible license sharing`);
    }
  } else if (role === "master") {
    gs.masters++;
  }
  
  // Send confirmation
  send(ws, {
    type: 'connected',
    group: group,
    strategy: strategy,
    timestamp: new Date().toISOString()
  });
  
  ws.on("message", data => {
    let msg;
    try { 
      msg = JSON.parse(data.toString()); 
    } catch { 
      return; 
    }
    
    // Handle heartbeat
    if (msg.type === "heartbeat") {
      send(ws, { type: "heartbeat_ack" });
      return;
    }

    // Telemetry: record activity for non-heartbeat messages (does NOT affect routing).
    maybeRollMessagesToday();
    const ms = statsFor(group);
    ms.lastMessageAt = new Date().toISOString();
    ms.messagesToday++;
    
    // Broadcast signals from master to children
    if (msg.type === "order" && role === "master") {
      let broadcastCount = 0;
      for (const [,c] of clients) {
        if (c.group === group && c.role === "child" && c.ws.readyState === WebSocket.OPEN) {
          send(c.ws, msg);
          broadcastCount++;
        }
      }
      console.log(`[Broadcast] ${group} → ${broadcastCount} child(ren): ${msg.action || 'signal'}`);
    }
    
    // Handle other message types (close, stop_move, target_move, etc.)
    if ((msg.type === "close" || msg.type === "stop_move" || msg.type === "target_move") && role === "master") {
      let broadcastCount = 0;
      for (const [,c] of clients) {
        if (c.group === group && c.role === "child" && c.ws.readyState === WebSocket.OPEN) {
          send(c.ws, msg);
          broadcastCount++;
        }
      }
      console.log(`[Broadcast] ${group} → ${msg.type} to ${broadcastCount} child(ren)`);
    }
  });
  
  ws.on("close", () => {
    clients.delete(id);
    // Telemetry: decrement per-group connection counters (does NOT affect routing).
    const cs = groupStats.get(group);
    if (cs) {
      if (role === "child" && cs.children > 0) cs.children--;
      else if (role === "master" && cs.masters > 0) cs.masters--;
    }
    console.log(`[-] ${role} disconnected from ${group}`);
  });
  
  ws.on("error", (err) => {
    console.error(`WebSocket error for ${role}:`, err.message);
  });
});

// ── WebSocket keepalive ─────────────────────────────────────────────────────
// Railway's edge proxy closes idle WebSocket connections (~once a minute), which
// was silently dropping BoardShop child connections between signals — a child that
// dropped and didn't reconnect missed the trade (this is what kept happening to one
// user). Send a tiny ping frame to every open socket every 30s so the proxy sees the
// connection as active and keeps it open. A ping is a few bytes — negligible load,
// and ping-only (no force-terminate) so a client that doesn't auto-pong is never cut.
const KEEPALIVE_MS = 30000;
const keepAlive = setInterval(() => {
  // App-level ping (a small JSON the CHILD can actually see via ReceiveAsync) — lets the child
  // detect a dead/half-open socket on an otherwise-silent connection and reconnect. Also send a
  // protocol ws.ping() to every socket so the proxy keeps the connection alive. Both are tiny.
  const pingMsg = JSON.stringify({ type: "ping", ts: Date.now() });
  for (const c of clients.values()) {
    if (!c.ws || c.ws.readyState !== WebSocket.OPEN) continue;
    try { c.ws.ping(); } catch (_) { /* ignore */ }
    if (c.role === "child") { try { c.ws.send(pingMsg); } catch (_) { /* ignore */ } }
  }
}, KEEPALIVE_MS);
wss.on("close", () => clearInterval(keepAlive));

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`ACE Relay running on port ${PORT}`);
  console.log(`Features: Strategy validation, CORS, Admin API`);
});
