import { isDeepStrictEqual } from 'node:util';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { emptyModelConfigDocument, modelConfigKey } from '../../src/shared/model-document';
import {
  appConfig,
  creditRateCard,
  modelAliases,
  modelConfigState,
  modelProviders,
} from '../../src/server/infra/schema';
import {
  backfillLegacyModelConfig,
  LegacyBackfillConflictError,
} from '../../src/server/models/legacy-backfill';

class BackfillCommandError extends Error {}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--apply') || args.length > 1) {
    throw new BackfillCommandError(
      'Usage: npm run db:backfill-model-config -- [--apply] (default: dry-run)',
    );
  }
  const apply = args.includes('--apply');
  let url: URL;
  try {
    url = new URL(process.env.DATABASE_URL ?? '');
  } catch {
    throw new BackfillCommandError(
      'DATABASE_URL must name a dedicated paimeng_app or paimeng_app_test Postgres database',
    );
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !/^paimeng_app(?:_test)?$/u.test(url.pathname.slice(1))
  ) {
    throw new BackfillCommandError(
      'DATABASE_URL must name a dedicated paimeng_app or paimeng_app_test Postgres database',
    );
  }
  const client = new pg.Client({ connectionString: url.href });
  try {
    await client.connect();
    const target = await client.query<{ database: string }>(
      'SELECT current_database() AS database',
    );
    if (target.rows[0]?.database !== url.pathname.slice(1)) {
      throw new BackfillCommandError(
        'Connected database does not match the dedicated app database in DATABASE_URL',
      );
    }
    // The read-only transaction guarantees a dry-run cannot write, even if its implementation changes.
    await client.query(
      apply
        ? 'BEGIN ISOLATION LEVEL REPEATABLE READ'
        : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
    );
    try {
      const database = drizzle(client);
      const query = database.select().from(appConfig).where(eq(appConfig.key, modelConfigKey));
      const [targetRow] = await (apply ? query.for('update') : query);
      if (!targetRow)
        throw new BackfillCommandError(
          'model_config row is missing; run db:migrate before backfilling',
        );
      const providers = await database.select().from(modelProviders).orderBy(modelProviders.id);
      const aliases = await database.select().from(modelAliases).orderBy(modelAliases.alias);
      const states = await database.select().from(modelConfigState);
      if (states.length !== 1)
        throw new BackfillCommandError('Expected exactly one legacy model_config_state row');
      const rateCards = await database
        .select()
        .from(creditRateCard)
        .orderBy(creditRateCard.providerId, creditRateCard.modelName, creditRateCard.effectiveFrom);
      const { document, report, version } = backfillLegacyModelConfig({
        providers,
        aliases,
        state: states[0],
        rateCards,
      });
      // Compare JSON values only: revision and refresh_epoch may have advanced after an earlier apply.
      const identical = isDeepStrictEqual(targetRow.value, document);
      if (!identical && !isDeepStrictEqual(targetRow.value, emptyModelConfigDocument())) {
        throw new LegacyBackfillConflictError({
          ...report,
          counts: { ...report.counts, conflicts: report.counts.conflicts + 1 },
          conflictMessages: [
            ...report.conflictMessages,
            'app_config already contains a different model configuration; review it before retrying',
          ],
        });
      }
      if (apply && !identical) {
        await database
          .update(appConfig)
          .set({
            value: document,
            revision: BigInt(version.revision),
            refreshEpoch: BigInt(version.refreshEpoch),
            updatedAt: sql`timezone('UTC', now())`,
          })
          .where(eq(appConfig.key, modelConfigKey));
      }
      await client.query('COMMIT');
      console.log(
        JSON.stringify(
          {
            mode: apply ? 'apply' : 'dry-run',
            outcome: identical ? 'no-op' : apply ? 'applied' : 'would-apply',
            ...report,
          },
          null,
          2,
        ),
      );
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    await client.end();
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof LegacyBackfillConflictError) {
    console.error(JSON.stringify(error.report, null, 2));
  } else if (error instanceof BackfillCommandError) {
    console.error(error.message);
  } else {
    // Driver messages, SQL parameters, URLs and stack traces can expose credentials or ciphertext.
    console.error(
      'Model config backfill failed; verify database connectivity, migrations and permissions. No changes were committed.',
    );
  }
  process.exitCode = 1;
}
