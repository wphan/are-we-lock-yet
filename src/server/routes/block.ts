import { Hono } from 'hono';
import type { Connection } from '@solana/web3.js';
import { getBlock, getLatestSlot, getLeaderFromBlock } from '../rpc.ts';
import { parseBlock } from '../../lib/parser.ts';
import { analyzeBlock } from '../../lib/cost-model.ts';
import type { BlockAnalysis } from '../../lib/types.ts';

// Simple LRU cache for recent blocks
const blockCache = new Map<number, BlockAnalysis>();
const MAX_CACHE_SIZE = 10;

function cacheBlock(slot: number, analysis: BlockAnalysis) {
  if (blockCache.size >= MAX_CACHE_SIZE) {
    const firstKey = blockCache.keys().next().value;
    if (firstKey !== undefined) {
      blockCache.delete(firstKey);
    }
  }
  blockCache.set(slot, analysis);
}

export function createBlockRoutes(connection: Connection) {
  const app = new Hono();

  app.get('/latest-slot', async (c) => {
    const slot = await getLatestSlot(connection);
    return c.json({ slot });
  });

  app.get('/:slot', async (c) => {
    const slotParam = c.req.param('slot');
    const slot = parseInt(slotParam, 10);

    if (isNaN(slot) || slot < 0) {
      return c.json({ error: 'Invalid slot number' }, 400);
    }

    // Check cache
    const cached = blockCache.get(slot);
    if (cached) {
      return c.json(cached);
    }

    try {
      const block = await getBlock(connection, slot);
      const leader = getLeaderFromBlock(block);
      const transactions = parseBlock(block);
      const analysis = analyzeBlock(
        slot,
        block.blockhash,
        block.parentSlot,
        block.blockTime ?? null,
        leader,
        transactions
      );

      cacheBlock(slot, analysis);

      return c.json(analysis);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown error';
      return c.json({ error: message }, 500);
    }
  });

  return app;
}
