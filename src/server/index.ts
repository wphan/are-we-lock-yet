import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from 'hono/bun';
import { createConnection } from './rpc.ts';
import { createBlockRoutes } from './routes/block.ts';

const app = new Hono();

// CORS for development
app.use('/api/*', cors());

// Create Solana connection
const rpcUrl = process.env.SOLANA_RPC_URL;
const connection = createConnection(rpcUrl);

// API routes
app.route('/api/block', createBlockRoutes(connection));

// Serve static files
app.use('/*', serveStatic({ root: './src/client' }));

// Health check
app.get('/health', (c) => c.json({ status: 'ok' }));

const port = parseInt(process.env.PORT ?? '3000', 10);

console.log(`Are We Lock Yet running at http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
};
