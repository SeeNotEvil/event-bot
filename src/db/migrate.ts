import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Kysely } from 'kysely';
import { Migrator, type MigrationProvider } from 'kysely/migration';
import { loadConfig } from '../config/config.js';
import { createLogger } from '../logger.js';
import { createDatabase } from './connection.js';
import * as initialMigration from './migrations/001_initial.js';
import * as userProfileMigration from './migrations/002_user_profile.js';
import * as notificationsMigration from './migrations/003_notifications.js';
import * as eventCompletionMigration from './migrations/004_event_completion.js';
import type { Database } from './types.js';

const migrationProvider: MigrationProvider = {
  getMigrations: () =>
    Promise.resolve({
      '001_initial': initialMigration,
      '002_user_profile': userProfileMigration,
      '003_notifications': notificationsMigration,
      '004_event_completion': eventCompletionMigration,
    }),
};

export async function migrateToLatest(database: Kysely<Database>): Promise<void> {
  const migrator = new Migrator({
    db: database,
    provider: migrationProvider,
  });

  const { error, results } = await migrator.migrateToLatest();

  for (const result of results ?? []) {
    if (result.status === 'Error') {
      throw new Error(`Migration ${result.migrationName} failed`);
    }
  }

  if (error) {
    throw error instanceof Error ? error : new Error('Migration failed', { cause: error });
  }
}

async function runFromCommandLine(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const database = createDatabase(config.database);

  try {
    await migrateToLatest(database);
    logger.info('Database migrations completed');
  } finally {
    await database.destroy();
  }
}

const currentFile = fileURLToPath(import.meta.url);
const entryFile = process.argv[1] ? path.resolve(process.argv[1]) : null;

if (entryFile === currentFile) {
  void runFromCommandLine().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
