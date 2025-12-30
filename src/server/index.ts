import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from 'hono/bun';
import blockHandler from '../../api/block/[slot]';

const app = new Hono();

// CORS for development
app.use('/api/*', cors());

// API routes - mimic Vercel function routing
app.all('/api/block/:slot', async (c) => {
  const slot = c.req.param('slot');

  // Create mock Vercel request/response
  const req = {
    query: { slot },
    method: c.req.method,
  };

  let statusCode = 200;
  let responseData: any;

  const res = {
    status: (code: number) => ({
      json: (data: any) => {
        statusCode = code;
        responseData = data;
        return res;
      }
    }),
    json: (data: any) => {
      responseData = data;
      return res;
    }
  };

  await blockHandler(req as any, res as any);

  return c.json(responseData, statusCode as any);
});

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
