const http = require("http");
const WebSocket = require("ws");
const url = require("url");

const server = http.createServer((req, res) => {
  res.writeHead(200, {"content-type":"text/plain"});
  res.end("ACE Relay: OK");
});

const wss = new WebSocket.Server({ server });
const clients = new Map();

function send(ws, obj){ try{ ws.send(JSON.stringify(obj)); } catch(_){} }

wss.on("connection", (ws, req) => {
  const q = url.parse(req.url, true).query;
  const role  = (q.role  || "").toString();
  const group = (q.group || "").toString();
  const key   = (q.apiKey|| "").toString();
  if (!role || !group || !key) { ws.close(); return; }

  const id = Math.random().toString(36).slice(2);
  clients.set(id, { ws, role, group });
  console.log(`[+] ${role} connected (${group})`);

  ws.on("message", data => {
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === "order" && role === "master") {
      for (const [,c] of clients)
        if (c.group===group && c.role==="child" && c.ws.readyState===WebSocket.OPEN)
          send(c.ws, msg);
      console.log(`[Broadcast] ${group} → ${JSON.stringify(msg)}`);
    }
  });

  ws.on("close", () => { clients.delete(id); console.log(`[-] ${role} disconnected (${group})`); });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, "0.0.0.0", () => console.log("ACE Relay running on port " + PORT));
