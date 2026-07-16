import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './utils/config.js';
import videosRouter from './routes/videos.js';
import sessionsRouter from './routes/sessions.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(event, payload) {
  const message = JSON.stringify({ event, payload });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(message);
    }
  });
}

app.locals.broadcast = broadcast;

app.use(express.json({ limit: '10mb' }));

// CORS: allow same-origin by default; configurable origins
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.options('*', (_req, res) => res.sendStatus(204));

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', port: config.port, time: new Date().toISOString() });
});

// API routes
app.use('/api/videos', videosRouter);
app.use('/api/sessions', sessionsRouter);

// Static frontend
app.use(express.static(join(__dirname, 'public')));

// SPA fallback
app.get('*', (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// Error handler
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// WebSocket
wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      // Echo pad triggers to all clients for potential future multi-user support
      if (message.event === 'pad:trigger' || message.event === 'pad:release') {
        broadcast(message.event, message.payload);
      }
    } catch (err) {
      console.error('Invalid WebSocket message:', err.message);
    }
  });

  ws.send(JSON.stringify({ event: 'ws:connected', payload: { time: Date.now() } }));
});

server.listen(config.port, config.host, () => {
  console.log(`PumaSamplerMusic running on http://${config.host}:${config.port}`);
});

export { app, server };
