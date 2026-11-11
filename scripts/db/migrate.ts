import { openDatabase } from '../../src/server/db/connection';
import { migrateDatabase } from '../../src/server/db/migrate';

try {
  const connection = openDatabase();
  try {
    const applied = migrateDatabase(connection);
    for (const name of applied) console.log(`applied ${name}`);
    if (applied.length === 0) console.log('database up to date');
  } finally {
    connection.close();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
