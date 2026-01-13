const http = require("http");
const WebSocket = require("ws");
const url = require("url");

const server = http.createServer((req, res) => {
  // CORS headers - allow WordPress to call API
  res.setHeader('Access-Control-Allow-Origin', 'https://acetradingbots.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  // Handle preflight requests
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
    
    // Build connections array from clients Map
    for (const [id, client] of clients) {
      connections.push({
        licenseKey: client.key || 'N/A',
        customerEmail: 'N/A',
        group: client.group || 'N/A',
        licenseStatus: 'active',
        connectedAt: client.connectedAt || new Date().toISOString(),
        lastValidated: new Date().toISOString(),
        role: client.role || 'N/A'
      });
    }
    
    // Calculate stats
    const groups = new Set();
    for (const client of clients.values()) {
      if (client.group) groups.add(client.group);
    }
    
    // Return JSON response
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
        
        // Disconnect all clients with this license key
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
  
  // Default response for root and other paths
  res.writeHead(200, {"Content-Type": "text/plain"});
  res.end("ACE Relay: OK");
});

// WebSocket server
const wss = new WebSocket.Server({ server });
const clients = new Map();

// Helper function to send JSON
function send(ws, obj){ 
  try{ 
    ws.send(JSON.stringify(obj)); 
  } catch(_){} 
}

// WebSocket connection handler
wss.on("connection", (ws, req) => {
  const q = url.parse(req.url, true).query;
  const role = (q.role || "").toString();
  const group = (q.group || "").toString();
  const key = (q.apiKey || "").toString();
  
  if (!role || !group || !key) { 
    ws.close(); 
    return; 
  }
  
  const id = Math.random().toString(36).slice(2);
  clients.set(id, { 
    ws, 
    role, 
    group, 
    key,
    connectedAt: new Date().toISOString()
  });
  
  console.log(`[+] ${role} connected ${group}`);
  
  // Handle incoming messages
  ws.on("message", data => {
    let msg;
    try { 
      msg = JSON.parse(data.toString()); 
    } catch { 
      return; 
    }
    
    if (msg.type === "order" && role === "master") {
      for (const [,c] of clients) {
        if (c.group === group && c.role === "child" && c.ws.readyState === WebSocket.OPEN) {
          send(c.ws, msg);
        }
      }
      console.log(`[Broadcast] ${group} → ${JSON.stringify(msg)}`);
    }
  });
  
  // Handle disconnection
  ws.on("close", () => {
    clients.delete(id);
    console.log(`[-] ${role} disconnected ${group}`);
  });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`ACE Relay running on port ${PORT}`);
});
