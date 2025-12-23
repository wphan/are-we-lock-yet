import type { VersionedBlockResponse, VersionedTransactionResponse } from '@solana/web3.js';
import {
  COMPUTE_BUDGET_PROGRAM_ID,
  VOTE_PROGRAM_ID,
  type TransactionMetrics,
} from './types.ts';

const DEFAULT_CU_LIMIT = 200_000;

// Compute budget instruction discriminators
const SET_COMPUTE_UNIT_LIMIT = 0x02;
const SET_COMPUTE_UNIT_PRICE = 0x03;

interface ParsedComputeBudget {
  cuLimit: number;
  cuPrice: number;
}

function parseComputeBudgetInstructions(
  tx: VersionedTransactionResponse
): ParsedComputeBudget {
  let cuLimit = DEFAULT_CU_LIMIT;
  let cuPrice = 0;

  const message = tx.transaction.message;
  const accountKeys = message.staticAccountKeys.map((k) => k.toBase58());

  // Add lookup table addresses for versioned transactions
  if ('addressTableLookups' in message && tx.meta?.loadedAddresses) {
    accountKeys.push(
      ...tx.meta.loadedAddresses.writable.map((k) => k.toBase58()),
      ...tx.meta.loadedAddresses.readonly.map((k) => k.toBase58())
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
      // u32 limit
      cuLimit = data[1]! | (data[2]! << 8) | (data[3]! << 16) | (data[4]! << 24);
    } else if (discriminator === SET_COMPUTE_UNIT_PRICE && data.length >= 9) {
      // u64 micro-lamports price
      const low =
        data[1]! | (data[2]! << 8) | (data[3]! << 16) | (data[4]! << 24);
      const high =
        data[5]! | (data[6]! << 8) | (data[7]! << 16) | (data[8]! << 24);
      cuPrice = low + high * 0x100000000;
    }
  }

  return { cuLimit, cuPrice };
}

function getWritableAccounts(tx: VersionedTransactionResponse): string[] {
  const message = tx.transaction.message;
  const accountKeys = message.staticAccountKeys.map((k) => k.toBase58());
  const writableAccounts: string[] = [];

  // Get header info for static accounts
  const header = message.header;
  const numStaticWritable =
    header.numRequiredSignatures - header.numReadonlySignedAccounts;
  const numUnsignedWritable =
    accountKeys.length -
    header.numRequiredSignatures -
    header.numReadonlyUnsignedAccounts;

  // Add writable signed accounts
  for (let i = 0; i < numStaticWritable; i++) {
    writableAccounts.push(accountKeys[i]!);
  }

  // Add writable unsigned accounts
  const unsignedStart = header.numRequiredSignatures;
  for (let i = 0; i < numUnsignedWritable; i++) {
    writableAccounts.push(accountKeys[unsignedStart + i]!);
  }

  // Add writable accounts from address lookup tables
  if (tx.meta?.loadedAddresses) {
    writableAccounts.push(
      ...tx.meta.loadedAddresses.writable.map((k) => k.toBase58())
    );
  }

  return writableAccounts;
}

function getSigners(tx: VersionedTransactionResponse): string[] {
  const message = tx.transaction.message;
  const accountKeys = message.staticAccountKeys.map((k) => k.toBase58());
  const numSigners = message.header.numRequiredSignatures;
  return accountKeys.slice(0, numSigners);
}

function isVoteTransaction(tx: VersionedTransactionResponse): boolean {
  const message = tx.transaction.message;
  const accountKeys = message.staticAccountKeys.map((k) => k.toBase58());

  for (const ix of message.compiledInstructions) {
    const programId = accountKeys[ix.programIdIndex];
    if (programId === VOTE_PROGRAM_ID) {
      return true;
    }
  }

  return false;
}

function getPrograms(tx: VersionedTransactionResponse): string[] {
  const message = tx.transaction.message;
  const accountKeys = message.staticAccountKeys.map((k) => k.toBase58());

  // Add lookup table addresses for versioned transactions
  if ('addressTableLookups' in message && tx.meta?.loadedAddresses) {
    accountKeys.push(
      ...tx.meta.loadedAddresses.writable.map((k) => k.toBase58()),
      ...tx.meta.loadedAddresses.readonly.map((k) => k.toBase58())
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

export function parseTransaction(
  tx: VersionedTransactionResponse,
  index: number
): TransactionMetrics {
  const signature =
    tx.transaction.signatures[0] ?? 'unknown';

  const { cuLimit, cuPrice } = parseComputeBudgetInstructions(tx);
  const cuUsed = tx.meta?.computeUnitsConsumed ?? 0;
  const writableAccounts = getWritableAccounts(tx);
  const signers = getSigners(tx);
  const programs = getPrograms(tx);
  const isVote = isVoteTransaction(tx);
  const status = tx.meta?.err ? 'failed' : 'success';

  // Calculate cost (estimated before execution)
  const numSignatures = tx.transaction.signatures.length;
  const signatureCost = 720 * numSignatures;
  const writeLockCost = 300 * writableAccounts.length;

  // Calculate instruction data bytes
  let dataBytes = 0;
  for (const ix of tx.transaction.message.compiledInstructions) {
    dataBytes += ix.data.length;
  }
  const dataBytesCost = Math.ceil(dataBytes / 32);

  const cost = signatureCost + writeLockCost + dataBytesCost + cuLimit;

  // Calculate prioritization fee
  const prioritizationFee = Math.ceil((cuPrice * cuLimit) / 1_000_000);
  const baseFee = 5000 * numSignatures;
  const reward = baseFee + prioritizationFee;

  // Calculate priority
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
    writableAccounts,
    signers,
    programs,
    status,
    isVote,
  };
}

export function parseBlock(block: VersionedBlockResponse): TransactionMetrics[] {
  const transactions: TransactionMetrics[] = [];

  for (let i = 0; i < block.transactions.length; i++) {
    const tx = block.transactions[i]!;
    if (!tx.meta) continue;
    transactions.push(parseTransaction(tx, i));
  }

  return transactions;
}
