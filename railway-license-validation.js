// Railway WebSocket Relay - License Validation Integration
// Add this to your existing relay server

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Store for connected clients with their licenses
const connectedClients = new Map(); // clientId -> { ws, licenseKey, lastValidated }

/**
 * Validate license with Supabase
 */
async function validateLicense(licenseKey) {
  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/licenses?license_key=eq.${licenseKey}&select=*,customers(*),products(*),websocket_groups(*)`,
      {
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    if (!response.ok) {
      console.error('License validation failed:', response.status);
      return { valid: false, reason: 'api_error' };
    }
    
    const data = await response.json();
    
    if (!data || data.length === 0) {
      return { valid: false, reason: 'not_found' };
    }
    
    const license = data[0];
    
    // Check status
    if (license.status !== 'active') {
      return { 
        valid: false, 
        reason: 'inactive',
        status: license.status 
      };
    }
    
    // Check expiration
    if (license.expires_at) {
      const expiryDate = new Date(license.expires_at);
      if (expiryDate < new Date()) {
        return { valid: false, reason: 'expired' };
      }
    }
    
    return {
      valid: true,
      license: license,
      group: license.websocket_groups?.group_name,
      customerId: license.customer_id
    };
    
  } catch (error) {
    console.error('License validation error:', error);
    return { valid: false, reason: 'error' };
  }
}

/**
 * Periodic validation check (every 5 minutes)
 */
setInterval(async () => {
  console.log('Running periodic license validation...');
  
  for (const [clientId, client] of connectedClients.entries()) {
    const { ws, licenseKey, lastValidated } = client;
    
    // Skip if validated recently (within last 5 minutes)
    if (lastValidated && (Date.now() - lastValidated) < 5 * 60 * 1000) {
      continue;
    }
    
    // Validate license
    const validation = await validateLicense(licenseKey);
    
    if (!validation.valid) {
      console.log(`License ${licenseKey} is no longer valid: ${validation.reason}`);
      
      // Send disconnect message to client
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'license_invalid',
          reason: validation.reason,
          status: validation.status,
          message: 'Your license is no longer active. Connection will be closed.'
        }));
        
        // Close connection after 5 seconds
        setTimeout(() => {
          ws.close(1008, `License ${validation.reason}`);
        }, 5000);
      }
      
      // Remove from connected clients
      connectedClients.delete(clientId);
      
    } else {
      // Update last validated timestamp
      client.lastValidated = Date.now();
      console.log(`License ${licenseKey} validated successfully`);
    }
  }
  
}, 5 * 60 * 1000); // Every 5 minutes

/**
 * On client connection
 */
wss.on('connection', async (ws, req) => {
  let clientId = null;
  let licenseKey = null;
  
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      
      // Handle authentication
      if (data.type === 'authenticate') {
        licenseKey = data.license_key;
        const hardwareId = data.hardware_id;
        
        // Validate license on connection
        const validation = await validateLicense(licenseKey);
        
        if (!validation.valid) {
          ws.send(JSON.stringify({
            type: 'auth_failed',
            reason: validation.reason,
            status: validation.status
          }));
          ws.close(1008, `License ${validation.reason}`);
          return;
        }
        
        // Store client connection
        clientId = `${licenseKey}-${Date.now()}`;
        connectedClients.set(clientId, {
          ws: ws,
          licenseKey: licenseKey,
          hardwareId: hardwareId,
          group: validation.group,
          customerId: validation.customerId,
          lastValidated: Date.now(),
          connectedAt: Date.now()
        });
        
        // Send success
        ws.send(JSON.stringify({
          type: 'auth_success',
          group: validation.group,
          message: 'Connected to signal feed'
        }));
        
        console.log(`Client authenticated: ${licenseKey} in group ${validation.group}`);
      }
      
      // ... rest of your message handling
      
    } catch (error) {
      console.error('Message handling error:', error);
    }
  });
  
  ws.on('close', () => {
    if (clientId) {
      connectedClients.delete(clientId);
      console.log(`Client disconnected: ${licenseKey}`);
    }
  });
});

/**
 * Heartbeat to keep track of active connections
 */
setInterval(() => {
  for (const [clientId, client] of connectedClients.entries()) {
    if (client.ws.readyState !== WebSocket.OPEN) {
      connectedClients.delete(clientId);
    }
  }
}, 30000); // Every 30 seconds

/**
 * Admin API endpoint to check active connections
 */
app.get('/admin/active-connections', (req, res) => {
  const connections = Array.from(connectedClients.values()).map(client => ({
    licenseKey: client.licenseKey,
    group: client.group,
    customerId: client.customerId,
    connectedAt: new Date(client.connectedAt).toISOString(),
    lastValidated: new Date(client.lastValidated).toISOString()
  }));
  
  res.json({
    count: connections.length,
    connections: connections
  });
});

/**
 * Admin API endpoint to disconnect specific license
 */
app.post('/admin/disconnect-license', async (req, res) => {
  const { license_key } = req.body;
  
  let disconnected = 0;
  
  for (const [clientId, client] of connectedClients.entries()) {
    if (client.licenseKey === license_key) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify({
          type: 'admin_disconnect',
          message: 'Your connection has been terminated by administrator'
        }));
        client.ws.close(1008, 'Admin disconnect');
      }
      connectedClients.delete(clientId);
      disconnected++;
    }
  }
  
  res.json({
    success: true,
    disconnected: disconnected
  });
});

console.log('License validation system active');
