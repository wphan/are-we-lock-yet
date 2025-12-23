import { Connection, type GetVersionedBlockConfig } from '@solana/web3.js';

const DEFAULT_RPC_URL = 'https://api.mainnet-beta.solana.com';

export function createConnection(rpcUrl?: string): Connection {
  return new Connection(rpcUrl ?? DEFAULT_RPC_URL, {
    commitment: 'confirmed',
  });
}

export async function getBlock(connection: Connection, slot: number) {
  const config: GetVersionedBlockConfig = {
    maxSupportedTransactionVersion: 0,
    transactionDetails: 'full',
    rewards: true, // Enable rewards to get leader info
  };

  const block = await connection.getBlock(slot, config);
  if (!block) {
    throw new Error(`Block not found for slot ${slot}`);
  }

  return block;
}

export function getLeaderFromBlock(block: { rewards?: Array<{ pubkey: string; rewardType: string | null }> | null }): string | null {
  // The leader receives a "Fee" reward for each block
  const leaderReward = block.rewards?.find(r => r.rewardType === 'Fee');
  return leaderReward?.pubkey ?? null;
}

export async function getLatestSlot(connection: Connection): Promise<number> {
  return connection.getSlot();
}
