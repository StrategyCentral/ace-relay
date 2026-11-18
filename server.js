const http = require("http");
const https = require("https");
const WebSocket = require("ws");
const url = require("url");
const crypto = require("crypto");

const processStartedAt = Date.now();

// Constant-time string compare (hash both sides so unequal lengths don't leak via timing).
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Admin auth: /admin/* routes require this header. No fallback — if unset, admin routes are locked.
const MASTER_API_KEY = process.env.MASTER_API_KEY;
function adminAuthed(req) {
  return !!MASTER_API_KEY && safeEqual(String(req.headers['x-master-key'] || ''), MASTER_API_KEY);
}

// GET /stats lists every relay group id. Callers (ops dashboard server, wavepark-master)
// do not all send x-master-key yet, so enforcement is GATED: set STATS_REQUIRE_MASTER_KEY=true
// once the "[STATS] unauthenticated caller" log line has stopped appearing.
const STATS_REQUIRE_MASTER_KEY = process.env.STATS_REQUIRE_MASTER_KEY === 'true';
const statsUnauthLogged = new Map();   // ip -> last time we logged it (bounded, 1 line/ip/hour)
function clientIp(req) {
  // Railway's edge APPENDS the real client IP, so the right-most hop is the one to trust.
  const xff = String(req.headers['x-forwarded-for'] || '');
  const hops = xff.split(',').map(h => h.trim()).filter(Boolean);
  return hops.length ? hops[hops.length - 1] : (req.socket && req.socket.remoteAddress) || '?';
}
function noteUnauthStats(req) {
  const ip = clientIp(req);
  const now = Date.now();
  if (now - (statsUnauthLogged.get(ip) || 0) < 3600000) return;
  if (statsUnauthLogged.size > 1000) statsUnauthLogged.clear();
  statsUnauthLogged.set(ip, now);
  console.warn(`[STATS] unauthenticated caller ip=${ip} ua=${String(req.headers['user-agent'] || '').slice(0, 80)}` +
    (STATS_REQUIRE_MASTER_KEY ? ' (refused)' : ' (allowed: STATS_REQUIRE_MASTER_KEY not set)'));
}

// ── S2: dedicated master authority ───────────────────────────────────────────
// Only a connection presenting this secret may join as role=master (and thus
// broadcast order/close/stop/target frames). Children never have it.
// MANDATORY: if RELAY_MASTER_SECRET is unset every master is refused (fail closed).
// ENFORCE_MASTER_SECRET is no longer read for this decision (it was the S1->S2 rollout gate,
// and is already 'true' in production).
const RELAY_MASTER_SECRET = process.env.RELAY_MASTER_SECRET;
if (!RELAY_MASTER_SECRET) {
  console.error('[CONFIG] RELAY_MASTER_SECRET is unset — ALL master connections will be refused (fail closed)');
}
if (process.env.ENFORCE_MASTER_SECRET && process.env.ENFORCE_MASTER_SECRET !== 'true') {
  console.warn('[CONFIG] ENFORCE_MASTER_SECRET is ignored: the master secret is always enforced');
}

// ── S1: license-backed connection validation ─────────────────────────────────
// The relay validates a child's (group, apiKey) against the SAME deterministic
// credential derivation the licensing server uses, over the set of currently
// active licenses. Read directly from Supabase REST (no extra npm dependency).
// Cache rules:
//  * Already-connected children are NEVER re-checked or kicked by anything here.
//  * After a successful load, a failed (or suspiciously empty) refresh keeps the last good
//    cache, so a Supabase blip can never lock out paying customers.
//  * During a startup grace (LICENSE_GRACE_MS) before the FIRST successful load, new children
//    are allowed (fail-open, as before). After the grace, if the cache has still never loaded,
//    new children with keys we cannot verify are REFUSED (fail closed). They auto-reconnect
//    and get in as soon as a load succeeds. Emergency override: RELAY_CHILD_FAIL_OPEN=true.
//  * A cache miss triggers at most ONE Supabase refetch per REFRESH_ON_MISS_MIN_MS, shared by
//    every concurrent miss (stops rejected children from hammering Supabase egress).
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const LICENSE_GRACE_MS = 60000;
const REFRESH_ON_MISS_MIN_MS = 10000;
const CHILD_FAIL_OPEN = process.env.RELAY_CHILD_FAIL_OPEN === 'true';

// EXACT copy of licensing generateUserCredentials — must stay identical or child
// apiKeys (issued by /api/activate) won't validate here.
function generateUserCredentials(licenseKey, strategy) {
  const strategyPrefix = strategy ? strategy.toLowerCase().replace(/[^a-z0-9]/g, '') : 'default';
  const hash = crypto.createHmac('sha256', process.env.CRED_SECRET || '')
    .update(licenseKey + strategyPrefix)
    .digest('hex');
  return {
    group: `${strategyPrefix}-${hash.substring(0, 12)}`,
    apiKey: `key-${hash.substring(12, 40)}`
  };
}

function httpsGetJson(fullUrl, headers) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(fullUrl); } catch (e) { return reject(e); }
    const req = https.request(
      { method: 'GET', hostname: u.hostname, path: u.pathname + u.search, headers },
      (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

let licenseCache = { rows: [], loaded: false, at: 0 };
let refreshInFlight = null;      // the one Supabase fetch currently running (coalesced)
let missRefresh = null;          // the one pending refresh-on-miss (shared by all misses)
let lastRefreshStartedAt = 0;

async function doRefreshLicenses() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.warn('[LICENSES] SUPABASE_URL / SUPABASE_SERVICE_KEY unset — license cache cannot load' +
      (CHILD_FAIL_OPEN ? ' (RELAY_CHILD_FAIL_OPEN=true: children allowed)' : ' (new children refused after startup grace)'));
    return;
  }
  try {
    const q = `${SUPABASE_URL}/rest/v1/licenses?status=eq.active&hardware_id=not.is.null` +
      `&select=license_key,allowed_strategies,expires_at,hardware_id`;
    const rows = await httpsGetJson(q, {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`
    });
    if (Array.isArray(rows)) {
      if (rows.length === 0 && licenseCache.loaded && licenseCache.rows.length > 0) {
        // An empty answer after a good load looks like a DB/RLS blip, not every customer
        // cancelling at once. Keep the last good cache rather than refuse paying customers.
        console.warn(`[LICENSES] refresh returned 0 rows (had ${licenseCache.rows.length}) — keeping previous cache`);
        return;
      }
      licenseCache = { rows, loaded: true, at: Date.now() };
      console.log(`[LICENSES] cache refreshed: ${rows.length} active license(s)`);
    }
  } catch (e) {
    console.error('[LICENSES] refresh failed (keeping previous cache):', e.message);
  }
}

// Coalesced: concurrent callers share the in-flight fetch.
function refreshLicenses() {
  if (refreshInFlight) return refreshInFlight;
  lastRefreshStartedAt = Date.now();
  refreshInFlight = doRefreshLicenses().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

// Rate-limited refresh for a cache miss: at most one per REFRESH_ON_MISS_MIN_MS. A miss inside
// the window waits for the next allowed refresh (so a just-activated child is still let in,
// a few seconds later) instead of triggering its own fetch.
function refreshOnMiss() {
  if (refreshInFlight) return refreshInFlight;
  if (missRefresh) return missRefresh;
  const wait = Math.max(0, lastRefreshStartedAt + REFRESH_ON_MISS_MIN_MS - Date.now());
  missRefresh = new Promise((resolve) => setTimeout(resolve, wait))
    .then(() => refreshLicenses())
    .finally(() => { missRefresh = null; });
  return missRefresh;
}

function isEligible(lic, strategy, now) {
  const allowed = lic.allowed_strategies || [];
  if (strategy !== 'MASTERTESTER' && allowed.length > 0 && !allowed.includes(strategy)) return false;   // empty = all-access
  if (lic.expires_at && new Date(lic.expires_at) < now) return false;
  return true;
}

function matchesChild(group, apiKey, strategy) {
  const now = new Date();
  for (const lic of licenseCache.rows) {
    if (!lic.license_key) continue;
    if (!isEligible(lic, strategy, now)) continue;
    const c = generateUserCredentials(lic.license_key, strategy);
    if (c.group === group && c.apiKey === apiKey) return true;
  }
  return false;
}

const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', 'https://acetradingbots.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Master-Key');

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
    if (!adminAuthed(req)) {
      res.writeHead(401, {"Content-Type": "application/json"});
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
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
    if (!adminAuthed(req)) {
      res.writeHead(401, {"Content-Type": "application/json"});
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
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

  // API ENDPOINT: Read-only stats for internal dashboard (no apiKeys leaked)
  if (parsedUrl.pathname === '/stats' && req.method === 'GET') {
    if (!adminAuthed(req)) {
      noteUnauthStats(req);
      if (STATS_REQUIRE_MASTER_KEY) {
        res.writeHead(401, {"Content-Type": "application/json"});
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }
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
    res.end(JSON.stringify({
      status: "ok",
      uptimeSeconds: Math.floor((Date.now() - serverStartedAt.getTime()) / 1000),
      licenseCacheLoaded: licenseCache.loaded,
      licenseCacheCount: licenseCache.rows.length
    }));
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

wss.on("connection", async (ws, req) => {
  const q = url.parse(req.url, true).query;
  const role = (q.role || "").toString();
  const group = (q.group || "").toString();
  const key = (q.apiKey || "").toString();
  const secret = (q.secret || "").toString();
  const strategy = (q.strategy || "").toString();

  if (!role || !group) {
    console.log('Connection rejected: missing role/group');
    ws.close();
    return;
  }

  // ── S1/S2 connection validation ────────────────────────────────────────────
  if (role === "master") {
    // S2: the dedicated master secret is mandatory. Unset secret = no masters (fail closed).
    if (!RELAY_MASTER_SECRET || !safeEqual(secret, RELAY_MASTER_SECRET)) {
      console.log(`[REJECT] master -> ${group}: missing/invalid master secret` +
        (RELAY_MASTER_SECRET ? '' : ' (RELAY_MASTER_SECRET unset on relay)'));
      ws.close();
      return;
    }
  } else if (role === "child") {
    if (!key) {
      console.log(`[REJECT] child -> ${group}: missing apiKey`);
      ws.close();
      return;
    }
    // S1: validate the child's (group, apiKey) against active licenses.
    const inGrace = Date.now() - processStartedAt < LICENSE_GRACE_MS;
    if (!licenseCache.loaded && (CHILD_FAIL_OPEN || inGrace)) {
      console.warn(`[WARN] license cache not loaded — allowing child -> ${group} (fail-open: ${CHILD_FAIL_OPEN ? 'RELAY_CHILD_FAIL_OPEN' : 'startup grace'})`);
    } else {
      let ok = licenseCache.loaded && matchesChild(group, key, strategy);
      if (!ok) {
        // A just-activated child may not be in the cache yet (or the cache never loaded) —
        // wait for the next rate-limited, shared refresh, then re-check once.
        await refreshOnMiss();
        ok = licenseCache.loaded && matchesChild(group, key, strategy);
      }
      if (!ok && !licenseCache.loaded && CHILD_FAIL_OPEN) ok = true;
      if (!ok) {
        console.log(`[REJECT] child -> ${group}: ` +
          (licenseCache.loaded ? `apiKey not tied to an active license (strategy=${strategy})`
                               : 'license cache has never loaded — cannot verify (fail closed)'));
        ws.close();
        return;
      }
    }
    if (ws.readyState !== WebSocket.OPEN) return;   // socket went away while we were checking
  } else {
    console.log(`[REJECT] unknown role: ${role}`);
    ws.close();
    return;
  }

  console.log(`Connection accepted: role=${role}, group=${group}, strategy=${strategy}`);

  const id = Math.random().toString(36).slice(2);
  clients.set(id, {
    ws,
    role,
    group,
    key,
    strategy,
    connectedAt: new Date().toISOString()
  });

  console.log(`[+] ${role} connected to ${group} (strategy: ${strategy})`);

  // Telemetry: bump per-group connection counters (does NOT affect routing).
  const gs = statsFor(group);
  if (role === "child") {
    gs.children++;
    if (gs.children > 1) {
      console.log(`[ABUSE] group ${group} now has ${gs.children} concurrent children — possible license sharing`);
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
      console.log(`[Broadcast] ${group} -> ${broadcastCount} child(ren): ${msg.action || 'signal'}`);
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
      console.log(`[Broadcast] ${group} -> ${msg.type} to ${broadcastCount} child(ren)`);
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
// Railway's edge proxy closes idle WebSocket connections (~once a minute). Send a
// tiny ping to every open socket every 30s so the proxy keeps the connection open.
const KEEPALIVE_MS = 30000;
const keepAlive = setInterval(() => {
  const pingMsg = JSON.stringify({ type: "ping", ts: Date.now() });
  for (const c of clients.values()) {
    if (!c.ws || c.ws.readyState !== WebSocket.OPEN) continue;
    try { c.ws.ping(); } catch (_) { /* ignore */ }
    if (c.role === "child") { try { c.ws.send(pingMsg); } catch (_) { /* ignore */ } }
  }
}, KEEPALIVE_MS);
wss.on("close", () => clearInterval(keepAlive));

// ── License cache: load on startup, refresh every 60s (fail-soft) ────────────
refreshLicenses();
const licenseRefresh = setInterval(refreshLicenses, 60000);
wss.on("close", () => clearInterval(licenseRefresh));

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`ACE Relay running on port ${PORT}`);
  console.log(`Features: S1 child license validation, S2 master secret, CORS, Admin API`);
});
