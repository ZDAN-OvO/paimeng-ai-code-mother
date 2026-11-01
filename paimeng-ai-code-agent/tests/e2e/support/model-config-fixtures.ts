import pg from 'pg';
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

export async function emptyModelConfig(client: pg.Client) {
  await client.query('DELETE FROM model_alias');
  await client.query('DELETE FROM provider_model');
  await client.query('DELETE FROM model_provider');
  await client.query(
    "INSERT INTO model_config_state (id, revision, refresh_epoch, update_time) VALUES ('models', 0, 0, timezone('UTC', now())) ON CONFLICT (id) DO UPDATE SET revision=0, refresh_epoch=0, update_time=timezone('UTC', now())",
  );
}

export async function seedModelConfig(client: pg.Client, baseUrl = 'https://api.example.test/v1') {
  await client.query('DELETE FROM model_alias');
  await client.query('DELETE FROM provider_model');
  await client.query('DELETE FROM model_provider');
  await client.query(
    "INSERT INTO model_provider (id, display_name, api_format, base_url, api_key_env, options, enabled, create_time, update_time) VALUES ($1,$2,$3,$4,$5,$6,$7,timezone('UTC', now()),timezone('UTC', now()))",
    ['env-default', '默认提供商', 'openai-chat', baseUrl, 'AI_API_KEY', JSON.stringify({}), 1],
  );
  const modelInsert =
    "INSERT INTO provider_model (id, provider_id, upstream_model_name, display_name, capabilities, compatibility, enabled, create_time, update_time) VALUES ($1,$2,$3,$4,$5,$6,$7,timezone('UTC', now()),timezone('UTC', now()))";
  const codegenModelId = '900000000000000001';
  const routeModelId = '900000000000000002';
  await client.query(modelInsert, [
    codegenModelId,
    'env-default',
    'test-codegen-model',
    '默认提供商 / test-codegen-model',
    JSON.stringify({ streaming: true, toolCalling: true, structuredOutput: false, imageInput: false }),
    JSON.stringify({}),
    1,
  ]);
  await client.query(modelInsert, [
    routeModelId,
    'env-default',
    'test-route-model',
    '默认提供商 / test-route-model',
    JSON.stringify({ streaming: false, toolCalling: false, structuredOutput: true, imageInput: false }),
    JSON.stringify({}),
    1,
  ]);
  const aliasInsert =
    "INSERT INTO model_alias (alias, provider_model_id, provider_id, model_name, capabilities, settings, enabled, create_time, update_time) VALUES ($1,$2,$3,$4,$5,$6,$7,timezone('UTC', now()),timezone('UTC', now()))";
  await client.query(aliasInsert, [
    'codegen.default',
    codegenModelId,
    'env-default',
    'test-codegen-model',
    JSON.stringify({ streaming: true, toolCalling: true, structuredOutput: false, imageInput: false }),
    JSON.stringify({}),
    1,
  ]);
  await client.query(aliasInsert, [
    'route.classify',
    routeModelId,
    'env-default',
    'test-route-model',
    JSON.stringify({ streaming: false, toolCalling: false, structuredOutput: true, imageInput: false }),
    JSON.stringify({}),
    1,
  ]);
  await client.query(
    "INSERT INTO model_config_state (id, revision, refresh_epoch, update_time) VALUES ('models', 1, 0, timezone('UTC', now())) ON CONFLICT (id) DO UPDATE SET revision=1, refresh_epoch=0, update_time=timezone('UTC', now())",
  );
}

export async function readProviderHeaders(client: pg.Client): Promise<Record<string, string>> {
  const { rows } = await client.query("SELECT headers FROM model_provider WHERE id='env-default'");
  const value = (rows as { headers: unknown }[])[0]?.headers;
  return typeof value === 'string' ? (JSON.parse(value) as Record<string, string>) : (value as Record<string, string>);
}
