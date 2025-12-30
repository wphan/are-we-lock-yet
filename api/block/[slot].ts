import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Connection } from '@solana/web3.js';
import type { VersionedBlockResponse } from '@solana/web3.js';

// Inlined constants
const MAX_BLOCK_UNITS = 48_000_000;
const MAX_WRITABLE_ACCOUNT_UNITS = 12_000_000;
const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
const VOTE_PROGRAM_ID = 'Vote111111111111111111111111111111111111111';
const DEFAULT_RPC_URL = 'https://api.mainnet-beta.solana.com';
const DEFAULT_CU_LIMIT = 200_000;
const SET_COMPUTE_UNIT_LIMIT = 0x02;
const SET_COMPUTE_UNIT_PRICE = 0x03;

// Inlined types
interface AccountInfo {
  address: string;
  isSigner: boolean;
  isWritable: boolean;
}

interface AccountStats {
  address: string;
  totalCUs: number;
  txCount: number;
  percentOfLimit: number;
  transactions: string[];
  signerCount: number;
  writeCount: number;
  readCount: number;
}

interface TransactionMetrics {
  index: number;
  signature: string;
  priority: number;
  cuPrice: number;
  cuLimit: number;
  cuUsed: number;
  cost: number;
  prioritizationFee: number;
  accounts: AccountInfo[];
  writableAccounts: string[];
  signers: string[];
  programs: string[];
  status: 'success' | 'failed';
  isVote: boolean;
}

interface ProgramStats {
  programId: string;
  txCount: number;
}

interface BlockAnalysis {
  slot: number;
  blockhash: string;
  parentSlot: number;
  blockTime: number | null;
  leader: string | null;
  totalCUs: number;
  totalTransactions: number;
  successfulTransactions: number;
  failedTransactions: number;
  voteTransactions: number;
  accountStats: AccountStats[];
  programStats: ProgramStats[];
  transactions: TransactionMetrics[];
  blockCapacity: number;
}

// Simple in-memory cache
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

function getLeaderFromBlock(block: { rewards?: Array<{ pubkey: string; rewardType: string | null }> | null }): string | null {
  const leaderReward = block.rewards?.find(r => r.rewardType === 'Fee');
  return leaderReward?.pubkey ?? null;
}

function parseComputeBudgetInstructions(tx: any): { cuLimit: number; cuPrice: number } {
  let cuLimit = DEFAULT_CU_LIMIT;
  let cuPrice = 0;

  const message = tx.transaction.message;
  const accountKeys = message.staticAccountKeys.map((k: any) => k.toBase58());

  if ('addressTableLookups' in message && tx.meta?.loadedAddresses) {
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
      cuLimit = data[1]! | (data[2]! << 8) | (data[3]! << 16) | (data[4]! << 24);
    } else if (discriminator === SET_COMPUTE_UNIT_PRICE && data.length >= 9) {
      const low = data[1]! | (data[2]! << 8) | (data[3]! << 16) | (data[4]! << 24);
      const high = data[5]! | (data[6]! << 8) | (data[7]! << 16) | (data[8]! << 24);
      cuPrice = low + high * 0x100000000;
    }
  }

  return { cuLimit, cuPrice };
}

function getWritableAccounts(tx: any): string[] {
  const message = tx.transaction.message;
  const accountKeys = message.staticAccountKeys.map((k: any) => k.toBase58());
  const writableAccounts: string[] = [];

  const header = message.header;
  const numStaticWritable = header.numRequiredSignatures - header.numReadonlySignedAccounts;
  const numUnsignedWritable = accountKeys.length - header.numRequiredSignatures - header.numReadonlyUnsignedAccounts;

  for (let i = 0; i < numStaticWritable; i++) {
    writableAccounts.push(accountKeys[i]!);
  }

  const unsignedStart = header.numRequiredSignatures;
  for (let i = 0; i < numUnsignedWritable; i++) {
    writableAccounts.push(accountKeys[unsignedStart + i]!);
  }

  if (tx.meta?.loadedAddresses) {
    writableAccounts.push(...tx.meta.loadedAddresses.writable.map((k: any) => k.toBase58()));
  }

  return writableAccounts;
}

function getSigners(tx: any): string[] {
  const message = tx.transaction.message;
  const accountKeys = message.staticAccountKeys.map((k: any) => k.toBase58());
  const numSigners = message.header.numRequiredSignatures;
  return accountKeys.slice(0, numSigners);
}

function getAllAccounts(tx: any): AccountInfo[] {
  const message = tx.transaction.message;
  const header = message.header;
  const staticKeys = message.staticAccountKeys.map((k: any) => k.toBase58());
  const accounts: AccountInfo[] = [];

  // Static accounts layout:
  // [0, numRequiredSignatures): signers
  //   [0, numRequiredSignatures - numReadonlySignedAccounts): writable signers
  //   [numRequiredSignatures - numReadonlySignedAccounts, numRequiredSignatures): readonly signers
  // [numRequiredSignatures, len - numReadonlyUnsignedAccounts): writable non-signers
  // [len - numReadonlyUnsignedAccounts, len): readonly non-signers

  const numSigners = header.numRequiredSignatures;
  const numWritableSigners = numSigners - header.numReadonlySignedAccounts;
  const numReadonlyUnsigned = header.numReadonlyUnsignedAccounts;
  const readonlyUnsignedStart = staticKeys.length - numReadonlyUnsigned;

  for (let i = 0; i < staticKeys.length; i++) {
    const address = staticKeys[i]!;
    const isSigner = i < numSigners;
    const isWritable = i < numWritableSigners || (i >= numSigners && i < readonlyUnsignedStart);
    accounts.push({ address, isSigner, isWritable });
  }

  // Add loaded addresses from ALT
  if (tx.meta?.loadedAddresses) {
    for (const addr of tx.meta.loadedAddresses.writable) {
      accounts.push({ address: addr.toBase58(), isSigner: false, isWritable: true });
    }
    for (const addr of tx.meta.loadedAddresses.readonly) {
      accounts.push({ address: addr.toBase58(), isSigner: false, isWritable: false });
    }
  }

  return accounts;
}

function isVoteTransaction(tx: any): boolean {
  const message = tx.transaction.message;
  const accountKeys = message.staticAccountKeys.map((k: any) => k.toBase58());

  for (const ix of message.compiledInstructions) {
    const programId = accountKeys[ix.programIdIndex];
    if (programId === VOTE_PROGRAM_ID) {
      return true;
    }
  }

  return false;
}

function getPrograms(tx: any): string[] {
  const message = tx.transaction.message;
  const accountKeys = message.staticAccountKeys.map((k: any) => k.toBase58());

  if ('addressTableLookups' in message && tx.meta?.loadedAddresses) {
    accountKeys.push(
      ...tx.meta.loadedAddresses.writable.map((k: any) => k.toBase58()),
      ...tx.meta.loadedAddresses.readonly.map((k: any) => k.toBase58())
    );
  }

  const programs = new Set<string>();
  for (const ix of message.compiledInstructions) {
    const programId = accountKeys[ix.programIdIndex];
    if (programId) {
      programs.add(programId);
    }
  }

  return [...programs];
}

function parseTransaction(tx: any, index: number): TransactionMetrics {
  const signature = tx.transaction.signatures[0] ?? 'unknown';

  const { cuLimit, cuPrice } = parseComputeBudgetInstructions(tx);
  const cuUsed = tx.meta?.computeUnitsConsumed ?? 0;
  const accounts = getAllAccounts(tx);
  const writableAccounts = accounts.filter(a => a.isWritable).map(a => a.address);
  const signers = accounts.filter(a => a.isSigner).map(a => a.address);
  const programs = getPrograms(tx);
  const isVote = isVoteTransaction(tx);
  const status = tx.meta?.err ? 'failed' : 'success';

  const numSignatures = tx.transaction.signatures.length;
  const signatureCost = 720 * numSignatures;
  const writeLockCost = 300 * writableAccounts.length;

  let dataBytes = 0;
  for (const ix of tx.transaction.message.compiledInstructions) {
    dataBytes += ix.data.length;
  }
  const dataBytesCost = Math.ceil(dataBytes / 32);

  const cost = signatureCost + writeLockCost + dataBytesCost + cuLimit;
  const prioritizationFee = Math.ceil((cuPrice * cuLimit) / 1_000_000);
  const baseFee = 5000 * numSignatures;
  const reward = baseFee + prioritizationFee;
  const priority = Math.floor((reward * 1_000_000) / (cost + 1));

  return {
    index,
    signature,
    priority,
    cuPrice,
    cuLimit,
    cuUsed,
    cost,
    prioritizationFee,
    accounts,
    writableAccounts,
    signers,
    programs,
    status: status as 'success' | 'failed',
    isVote,
  };
}

function parseBlock(block: VersionedBlockResponse): TransactionMetrics[] {
  const transactions: TransactionMetrics[] = [];

  for (let i = 0; i < block.transactions.length; i++) {
    const tx = block.transactions[i]!;
    if (!tx.meta) continue;
    transactions.push(parseTransaction(tx, i));
  }

  return transactions;
}

function analyzeBlock(
  slot: number,
  blockhash: string,
  parentSlot: number,
  blockTime: number | null,
  leader: string | null,
  transactions: TransactionMetrics[]
): BlockAnalysis {
  const accountMap = new Map<string, {
    totalCUs: number;
    txCount: number;
    transactions: string[];
    signerCount: number;
    writeCount: number;
    readCount: number;
  }>();
  const programMap = new Map<string, number>();

  let totalCUs = 0;
  let successfulTransactions = 0;
  let failedTransactions = 0;
  let voteTransactions = 0;

  for (const tx of transactions) {
    totalCUs += tx.cuUsed;

    if (tx.isVote) {
      voteTransactions++;
    }

    if (tx.status === 'success') {
      successfulTransactions++;
    } else {
      failedTransactions++;
    }

    // Track all accounts with their roles
    for (const account of tx.accounts) {
      const existing = accountMap.get(account.address) || {
        totalCUs: 0,
        txCount: 0,
        transactions: [],
        signerCount: 0,
        writeCount: 0,
        readCount: 0,
      };

      // Only count CUs for writable accounts
      if (account.isWritable) {
        existing.totalCUs += tx.cuLimit;
        existing.writeCount += 1;
      } else {
        existing.readCount += 1;
      }

      if (account.isSigner) {
        existing.signerCount += 1;
      }

      existing.txCount += 1;
      if (!existing.transactions.includes(tx.signature)) {
        existing.transactions.push(tx.signature);
      }
      accountMap.set(account.address, existing);
    }

    for (const program of tx.programs) {
      programMap.set(program, (programMap.get(program) || 0) + 1);
    }
  }

  const accountStats: AccountStats[] = [];
  for (const [address, stats] of accountMap.entries()) {
    accountStats.push({
      address,
      totalCUs: stats.totalCUs,
      txCount: stats.txCount,
      percentOfLimit: (stats.totalCUs / MAX_WRITABLE_ACCOUNT_UNITS) * 100,
      transactions: stats.transactions,
      signerCount: stats.signerCount,
      writeCount: stats.writeCount,
      readCount: stats.readCount,
    });
  }

  // Sort by totalCUs (write lock contention), then by txCount
  accountStats.sort((a, b) => b.totalCUs - a.totalCUs || b.txCount - a.txCount);

  const programStats: ProgramStats[] = [];
  for (const [programId, txCount] of programMap.entries()) {
    programStats.push({ programId, txCount });
  }
  programStats.sort((a, b) => b.txCount - a.txCount);

  const blockCapacity = (totalCUs / MAX_BLOCK_UNITS) * 100;

  return {
    slot,
    blockhash,
    parentSlot,
    blockTime,
    leader,
    totalCUs,
    totalTransactions: transactions.length,
    successfulTransactions,
    failedTransactions,
    voteTransactions,
    accountStats,
    programStats,
    transactions,
    blockCapacity,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { slot: slotParam } = req.query;

  // Handle "latest" slot request
  if (slotParam === 'latest') {
    try {
      const rpcUrl = process.env.SOLANA_RPC_URL || DEFAULT_RPC_URL;
      const connection = new Connection(rpcUrl, { commitment: 'confirmed' });
      const slot = await connection.getSlot();
      return res.status(200).json({ slot });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return res.status(500).json({ error: message });
    }
  }

  const slot = parseInt(slotParam as string, 10);

  if (isNaN(slot) || slot < 0) {
    return res.status(400).json({ error: 'Invalid slot number' });
  }

  // Check cache
  const cached = blockCache.get(slot);
  if (cached) {
    return res.status(200).json(cached);
  }

  try {
    const rpcUrl = process.env.SOLANA_RPC_URL || DEFAULT_RPC_URL;
    const connection = new Connection(rpcUrl, { commitment: 'confirmed' });

    const block = await connection.getBlock(slot, {
      maxSupportedTransactionVersion: 0,
      transactionDetails: 'full',
      rewards: true,
    });

    if (!block) {
      return res.status(404).json({ error: `Block not found for slot ${slot}` });
    }

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

    return res.status(200).json(analysis);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return res.status(500).json({ error: message });
  }
}
