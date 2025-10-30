# ACE Relay (Ultra-Minimal)

Real-time WebSocket relay for copy-trading signals.

## Deploy (Railway)
1. Create a **new** Railway project → Deploy from GitHub (or upload these files to a new GitHub repo).
2. Environment variable: `PORT=8080`
3. Start command: `node server.js`
4. Visit your app URL → should show **"ACE Relay: OK"**.

## Connect
- Master: `wss://YOUR-URL/?role=master&group=oil-desk&apiKey=test-key`
- Child:  `wss://YOUR-URL/?role=child&group=oil-desk&apiKey=test-key`

Send an order from master (JSON):
```
{"type":"order","signal_id":"test-1","symbol":"NQ 12-25","action":"BUY","order_type":"MARKET","quantity":1,"sl_ticks":30,"tp_ticks":60}
```
