import pg from 'pg';
import { emptyModelConfigDocument, type ModelConfigDocument } from '../../../src/shared/model-document';
import { testDatabaseUrl } from '../../support/test-database-url';

export async function testConnection(): Promise<pg.Client> {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('Browser tests require DATABASE_URL from the local .env file');
  const client = new pg.Client({ connectionString: new URL(testDatabaseUrl(raw)).href });
  await client.connect();
  return client;
}

export async function grantAdmin(client: pg.Client, account: string) {
  await client.query("UPDATE app_user SET user_role='admin' WHERE user_account=$1", [account]);
}

async function writeModelConfig(client: pg.Client, document: ModelConfigDocument, revision: number) {
  await client.query(
    `INSERT INTO app_config (key, revision, refresh_epoch, value, updated_at)
     VALUES ('model_config', $1, 0, $2::jsonb, timezone('UTC', now()))
     ON CONFLICT (key) DO UPDATE SET revision=EXCLUDED.revision, refresh_epoch=0,
       value=EXCLUDED.value, updated_at=EXCLUDED.updated_at`,
    [revision, JSON.stringify(document)],
  );
}

export async function emptyModelConfig(client: pg.Client) {
  await writeModelConfig(client, emptyModelConfigDocument(), 0);
}

export async function seedModelConfig(client: pg.Client, baseUrl = 'https://api.example.test/v1') {
  const timestamp = '2020-01-01 00:00:00.000';
  const price = {
    version: 1,
    effectiveAt: timestamp,
    currency: 'CNY' as const,
    inputMissFen: 600,
    inputHitFen: 12,
    outputFen: 2500,
    upstreamUsd: null,
    note: null,
  };
  await writeModelConfig(client, {
    schemaVersion: 1,
    providers: [{
      id: 'env-default',
      displayName: '默认提供商',
      apiFormat: 'openai-chat',
      baseUrl,
      apiKey: { source: 'env', env: 'AI_API_KEY' },
      options: {},
      headers: {},
      enabled: true,
      models: [
        {
          id: 'pm_e2e1',
          upstream: 'test-codegen-model',
          displayName: 'test-codegen-model',
          enabled: true,
          capabilities: { streaming: true, toolCalling: true, structuredOutput: false, imageInput: false },
          upstreamPrice: null,
          prices: [{ ...price }],
          createTime: timestamp,
          updateTime: timestamp,
        },
        {
          id: 'pm_e2e2',
          upstream: 'test-route-model',
          displayName: 'test-route-model',
          enabled: true,
          capabilities: { streaming: false, toolCalling: false, structuredOutput: true, imageInput: false },
          upstreamPrice: null,
          prices: [{ ...price }],
          createTime: timestamp,
          updateTime: timestamp,
        },
      ],
      createTime: timestamp,
      updateTime: timestamp,
    }],
    slots: [
      { slot: 'codegen.default', modelId: 'pm_e2e1', settings: {} },
      { slot: 'route.classify', modelId: 'pm_e2e2', settings: {} },
    ],
    legacyPrices: [],
  }, 1);
}

export async function readProviderHeaders(client: pg.Client): Promise<Record<string, string>> {
  const { rows } = await client.query<{ headers: Record<string, string> }>(
    `SELECT provider->'headers' AS headers FROM app_config,
       jsonb_array_elements(value->'providers') AS provider
     WHERE key='model_config' AND provider->>'id'='env-default'`,
  );
  return rows[0]?.headers ?? {};
}
