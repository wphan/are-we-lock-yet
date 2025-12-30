// Block ingestion logic shared between API and backfill script
import { Connection, type VersionedBlockResponse } from "@solana/web3.js";
import { getDb } from "./db/index.ts";

const MAX_WRITABLE_ACCOUNT_UNITS = 12_000_000;
const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
const DEFAULT_CU_LIMIT = 200_000;
const SET_COMPUTE_UNIT_LIMIT = 0x02;

// Batch processing requires a paid RPC - public RPC will be rate-limited

export interface AccountBlockStats {
  address: string;
  totalCUs: number;
  txCount: number;
  percentOfLimit: number;
}

export interface BlockData {
  slot: number;
  blockTime: number | null;
  totalCUs: number;
  accountStats: AccountBlockStats[];
}

function parseComputeBudgetInstructions(tx: any): number {
  let cuLimit = DEFAULT_CU_LIMIT;

  const message = tx.transaction.message;
  const accountKeys = message.staticAccountKeys.map((k: any) => k.toBase58());

  if ("addressTableLookups" in message && tx.meta?.loadedAddresses) {
    accountKeys.push(
      ...tx.meta.loadedAddresses.writable.map((k: any) => k.toBase58()),
      ...tx.meta.loadedAddresses.readonly.map((k: any) => k.toBase58())
    );
  }

  const instructions = message.compiledInstructions;
  for (const ix of instructions) {
    const programId = accountKeys[ix.programIdIndex];
    if (programId !== COMPUTE_BUDGET_PROGRAM_ID) continue;

    const data = ix.data;
    if (data.length === 0) continue;

    const discriminator = data[0];

    if (discriminator === SET_COMPUTE_UNIT_LIMIT && data.length >= 5) {
      cuLimit =
        data[1]! | (data[2]! << 8) | (data[3]! << 16) | (data[4]! << 24);
    }
  }

  return cuLimit;
}

function getWritableAccounts(tx: any): string[] {
  const message = tx.transaction.message;
  const accountKeys = message.staticAccountKeys.map((k: any) => k.toBase58());
  const writableAccounts: string[] = [];

  const header = message.header;
  const numStaticWritable =
    header.numRequiredSignatures - header.numReadonlySignedAccounts;
  const numUnsignedWritable =
    accountKeys.length -
    header.numRequiredSignatures -
    header.numReadonlyUnsignedAccounts;

  for (let i = 0; i < numStaticWritable; i++) {
    writableAccounts.push(accountKeys[i]!);
  }

  const unsignedStart = header.numRequiredSignatures;
  for (let i = 0; i < numUnsignedWritable; i++) {
    writableAccounts.push(accountKeys[unsignedStart + i]!);
  }

  if (tx.meta?.loadedAddresses) {
    writableAccounts.push(
      ...tx.meta.loadedAddresses.writable.map((k: any) => k.toBase58())
    );
  }

  return writableAccounts;
}

export function parseBlockForStats(
  block: VersionedBlockResponse,
  slot: number
): BlockData {
  const accountMap = new Map<string, { totalCUs: number; txCount: number }>();
  let totalCUs = 0;

  for (const tx of block.transactions) {
    if (!tx.meta) continue;

    const cuLimit = parseComputeBudgetInstructions(tx);
    const writableAccounts = getWritableAccounts(tx);

    totalCUs += tx.meta.computeUnitsConsumed ?? 0;

    for (const account of writableAccounts) {
      const existing = accountMap.get(account);
      if (existing) {
        existing.totalCUs += cuLimit;
        existing.txCount += 1;
      } else {
        accountMap.set(account, { totalCUs: cuLimit, txCount: 1 });
      }
    }
  }

  const accountStats: AccountBlockStats[] = [];
  for (const [address, stats] of accountMap) {
    accountStats.push({
      address,
      totalCUs: stats.totalCUs,
      txCount: stats.txCount,
      // Percent of 12M limit = account's CU limit / MAX_WRITABLE_ACCOUNT_UNITS
      percentOfLimit: (stats.totalCUs / MAX_WRITABLE_ACCOUNT_UNITS) * 100,
    });
  }

  // Sort by totalCUs descending
  accountStats.sort((a, b) => b.totalCUs - a.totalCUs);

  return {
    slot,
    blockTime: block.blockTime ?? null,
    totalCUs,
    accountStats,
  };
}

export async function fetchBlock(
  connection: Connection,
  slot: number
): Promise<VersionedBlockResponse | null> {
  try {
    const block = await connection.getBlock(slot, {
      maxSupportedTransactionVersion: 0,
      transactionDetails: "full",
      rewards: false,
    });
    return block;
  } catch (error) {
    // Slot might be skipped or not yet available
    return null;
  }
}

export async function upsertHourlyStats(blockData: BlockData): Promise<void> {
  if (!blockData.blockTime) return;

  const db = getDb();
  const bucketHour = new Date(blockData.blockTime * 1000);
  bucketHour.setMinutes(0, 0, 0);
  const bucketHourStr = bucketHour.toISOString();

  // Only process top 100 accounts to limit database writes
  const topAccounts = blockData.accountStats.slice(0, 100);

  for (const account of topAccounts) {
    await db.execute(
      `INSERT INTO account_stats_hourly
        (account_address, bucket_hour, total_cu, block_count, tx_count, max_percent_of_limit, avg_percent_of_limit, total_block_cu)
      VALUES ($1, $2, $3, 1, $4, $5, $5, $6)
      ON CONFLICT (account_address, bucket_hour) DO UPDATE SET
        total_cu = account_stats_hourly.total_cu + EXCLUDED.total_cu,
        block_count = account_stats_hourly.block_count + 1,
        tx_count = account_stats_hourly.tx_count + EXCLUDED.tx_count,
        max_percent_of_limit = GREATEST(account_stats_hourly.max_percent_of_limit, EXCLUDED.max_percent_of_limit),
        avg_percent_of_limit = (account_stats_hourly.avg_percent_of_limit * account_stats_hourly.block_count + EXCLUDED.avg_percent_of_limit)
                               / (account_stats_hourly.block_count + 1),
        total_block_cu = account_stats_hourly.total_block_cu + EXCLUDED.total_block_cu`,
      [
        account.address,
        bucketHourStr,
        account.totalCUs,
        account.txCount,
        account.percentOfLimit,
        blockData.totalCUs,
      ]
    );
  }
}

export async function saveBlockSnapshot(blockData: BlockData): Promise<void> {
  if (!blockData.blockTime) return;

  const db = getDb();
  const blockTime = new Date(blockData.blockTime * 1000).toISOString();

  // Store top 20 accounts
  const topAccounts = blockData.accountStats.slice(0, 20).map((a) => ({
    address: a.address,
    totalCUs: a.totalCUs,
    txCount: a.txCount,
    percentOfLimit: a.percentOfLimit,
  }));

  await db.execute(
    `INSERT INTO block_snapshots (slot, block_time, total_cu, top_accounts)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (slot) DO NOTHING`,
    [blockData.slot, blockTime, blockData.totalCUs, JSON.stringify(topAccounts)]
  );
}

export async function getLastProcessedSlot(): Promise<number | null> {
  const db = getDb();
  const result = await db.query<{ last_processed_slot: string }>(
    "SELECT last_processed_slot FROM ingest_state WHERE id = 1"
  );
  if (result.length === 0) return null;
  return parseInt(result[0].last_processed_slot, 10);
}

export async function updateLastProcessedSlot(slot: number): Promise<void> {
  const db = getDb();
  await db.execute(
    `INSERT INTO ingest_state (id, last_processed_slot, updated_at)
     VALUES (1, $1, NOW())
     ON CONFLICT (id) DO UPDATE SET
       last_processed_slot = EXCLUDED.last_processed_slot,
       updated_at = EXCLUDED.updated_at`,
    [slot]
  );
}

export function getConnection(): Connection {
  const rpcUrl = process.env.SOLANA_RPC_URL;
  if (!rpcUrl) {
    throw new Error(
      "SOLANA_RPC_URL environment variable is required for batch processing"
    );
  }
  return new Connection(rpcUrl, { commitment: "confirmed" });
}

export async function processBlocks(
  startSlot: number,
  endSlot: number,
  options: {
    batchSize?: number;
    delayMs?: number;
    onProgress?: (processed: number, total: number) => void;
    saveSnapshots?: boolean;
  } = {}
): Promise<{ processed: number; errors: number }> {
  const {
    batchSize = 50,
    delayMs = 1000,
    onProgress,
    saveSnapshots = false,
  } = options;

  const connection = getConnection();
  const total = endSlot - startSlot + 1;
  let processed = 0;
  let errors = 0;

  for (let slot = startSlot; slot <= endSlot; slot += batchSize) {
    const batchEnd = Math.min(slot + batchSize - 1, endSlot);
    const slots = Array.from(
      { length: batchEnd - slot + 1 },
      (_, i) => slot + i
    );

    const promises = slots.map(async (s) => {
      try {
        const block = await fetchBlock(connection, s);
        if (block) {
          const blockData = parseBlockForStats(block, s);
          await upsertHourlyStats(blockData);
          if (saveSnapshots) {
            await saveBlockSnapshot(blockData);
          }
          return true;
        }
        return false;
      } catch (error) {
        errors++;
        return false;
      }
    });

    const results = await Promise.all(promises);
    processed += results.filter(Boolean).length;

    if (onProgress) {
      onProgress(processed, total);
    }

    // Update last processed slot
    await updateLastProcessedSlot(batchEnd);

    // Delay between batches to avoid rate limiting
    if (slot + batchSize <= endSlot) {
      await Bun.sleep(delayMs);
    }
  }

  return { processed, errors };
}
