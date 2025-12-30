import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from 'hono/bun';
import blockHandler from '../../api/block/[slot]';
import hotAccountsHandler from '../../api/analytics/hot-accounts';
import accountHistoryHandler from '../../api/analytics/account-history';
import statsHandler from '../../api/analytics/stats';
import accountLookupHandler from '../../api/analytics/account-lookup';
import accountBlocksHandler from '../../api/analytics/account-blocks';

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

// Analytics API routes
app.get('/api/analytics/hot-accounts', async (c) => {
  const req = {
    query: {
      range: c.req.query('range'),
      metric: c.req.query('metric'),
      limit: c.req.query('limit'),
    },
    method: 'GET',
  };

  let statusCode = 200;
  let responseData: any;
  let headers: Record<string, string> = {};

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
    },
    setHeader: (key: string, value: string) => {
      headers[key] = value;
    },
  };

  await hotAccountsHandler(req as any, res as any);
  return c.json(responseData, statusCode as any);
});

app.get('/api/analytics/account-history', async (c) => {
  const req = {
    query: {
      accounts: c.req.query('accounts'),
      range: c.req.query('range'),
    },
    method: 'GET',
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
    },
    setHeader: () => {},
  };

  await accountHistoryHandler(req as any, res as any);
  return c.json(responseData, statusCode as any);
});

app.get('/api/analytics/stats', async (c) => {
  const req = {
    query: {},
    method: 'GET',
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
    },
    setHeader: () => {},
  };

  await statsHandler(req as any, res as any);
  return c.json(responseData, statusCode as any);
});

app.get('/api/analytics/account-lookup', async (c) => {
  const req = {
    query: {
      address: c.req.query('address'),
      range: c.req.query('range'),
      metric: c.req.query('metric'),
    },
    method: 'GET',
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
    },
    setHeader: () => {},
  };

  await accountLookupHandler(req as any, res as any);
  return c.json(responseData, statusCode as any);
});

app.get('/api/analytics/account-blocks', async (c) => {
  const req = {
    query: {
      address: c.req.query('address'),
      range: c.req.query('range'),
      limit: c.req.query('limit'),
    },
    method: 'GET',
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
    },
    setHeader: () => {},
  };

  await accountBlocksHandler(req as any, res as any);
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
