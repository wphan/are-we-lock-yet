// Database connection utility
// Supports both local Postgres (via bun:sql) and Vercel Postgres

import { SQL } from "bun";

export interface DbClient {
  execute(query: string, params?: any[]): Promise<any[]>;
  query<T = any>(query: string, params?: any[]): Promise<T[]>;
}

let dbInstance: DbClient | null = null;

class BunSqlClient implements DbClient {
  private sql: SQL;

  constructor(connectionString: string) {
    this.sql = new SQL(connectionString);
  }

  async execute(query: string, params: any[] = []): Promise<any[]> {
    // For Bun SQL, we need to use tagged template literals or unsafe
    const result = await this.sql.unsafe(query, params);
    return Array.isArray(result) ? result : [];
  }

  async query<T = any>(query: string, params: any[] = []): Promise<T[]> {
    const result = await this.sql.unsafe(query, params);
    return Array.isArray(result) ? (result as T[]) : [];
  }
}

export function getDb(): DbClient {
  if (dbInstance) {
    return dbInstance;
  }

  const connectionString = process.env.POSTGRES_URL;

  if (!connectionString) {
    throw new Error(
      "POSTGRES_URL environment variable is required. " +
        "For local development, set it in .env.local"
    );
  }

  dbInstance = new BunSqlClient(connectionString);
  return dbInstance;
}

// Helper to build parameterized queries
export function sql(
  strings: TemplateStringsArray,
  ...values: any[]
): { text: string; values: any[] } {
  let text = "";
  const params: any[] = [];

  for (let i = 0; i < strings.length; i++) {
    text += strings[i];
    if (i < values.length) {
      params.push(values[i]);
      text += `$${params.length}`;
    }
  }

  return { text, values: params };
}

// Execute a tagged template query
export async function query<T = any>(
  strings: TemplateStringsArray,
  ...values: any[]
): Promise<T[]> {
  const db = getDb();
  const { text, values: params } = sql(strings, ...values);
  return db.query<T>(text, params);
}

// Execute a tagged template statement
export async function execute(
  strings: TemplateStringsArray,
  ...values: any[]
): Promise<any[]> {
  const db = getDb();
  const { text, values: params } = sql(strings, ...values);
  return db.execute(text, params);
}
