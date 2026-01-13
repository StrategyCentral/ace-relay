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
  
  // Handle API endpoints
  const parsedUrl = url.parse(req.url, true);
  
  // Active connections endpoint
  if (parsedUrl.pathname === '/admin/active-connections' && req.method === 'GET') {
    const connections = [];
    for (const [id, client] of clients) {
      connections.push({
        id: id,
        role: client.role,
        group: client.group,
        licenseKey: client.key || 'N/A',
        connectedAt: client.connectedAt || new Date().toISOString(),
        licenseStatus: 'active'
      });
    }
    
    res.writeHead(200, {"Content-Type": "application/json"});
    res.end(JSON.stringify({
      count: clients.size,
      signals_today: 0,
      active_groups: new Set([...clients.values()].map(c => c.group)).size,
      avg_latency: 3,
      connections: connections
    }));
    return;
  }
  
  // Disconnect license endpoint
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
            client.ws.close();
            clients.delete(id);
            disconnected++;
          }
        }
        
        res.writeHead(200, {"Content-Type": "application/json"});
        res.end(JSON.stringify({
          success: true,
          disconnected: disconnected
        }));
      } catch (err) {
        res.writeHead(400, {"Content-Type": "application/json"});
        res.end(JSON.stringify({error: 'Invalid request'}));
      }
    });
    return;
  }
  
  // Default response
  res.writeHead(200, {"Content-Type": "text/plain"});
  res.end("ACE Relay: OK");
});

const wss = new WebSocket.Server({ server });
const clients = new Map();

// Rest of your code continues...
