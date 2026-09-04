import { Kysely, MysqlDialect, sql } from 'kysely';
import { createPool } from 'mysql2';
import type { AppConfig } from '../config/config.js';
import type { Database } from './types.js';

export function createDatabase(config: AppConfig['database']): Kysely<Database> {
  const pool = createPool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    connectionLimit: 10,
    enableKeepAlive: true,
    timezone: 'Z',
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
    charset: 'utf8mb4',
  });

  return new Kysely<Database>({
    dialect: new MysqlDialect({ pool }),
  });
}

export async function isDatabaseHealthy(database: Kysely<Database>): Promise<boolean> {
  try {
    await sql`select 1`.execute(database);
    return true;
  } catch {
    return false;
  }
}
