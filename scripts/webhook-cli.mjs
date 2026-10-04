import { randomBytes } from 'node:crypto';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
const client = new SecretManagerServiceClient();
const project = process.env.GOOGLE_CLOUD_PROJECT ?? 'mom-im-ok-places';
const mode = process.argv[2];
async function read(name) {
  const [version] = await client.accessSecretVersion({
    name: `projects/${project}/secrets/${name}/versions/latest`,
  });
  const value = version.payload?.data?.toString();
  if (!value) throw new Error();
  return value;
}
async function main() {
  if (!['set', 'status', 'remove', 'init-secret'].includes(mode))
    throw new Error();
  if (mode === 'init-secret') {
    const [versions] = await client.listSecretVersions({
      parent: `projects/${project}/secrets/TELEGRAM_WEBHOOK_SECRET`,
      pageSize: 1,
    });
    if (versions.length) throw new Error(); // never overwrite/reveal an existing webhook secret
    await client.addSecretVersion({
      parent: `projects/${project}/secrets/TELEGRAM_WEBHOOK_SECRET`,
      payload: { data: Buffer.from(randomBytes(32).toString('base64url')) },
    });
    console.info('webhook_secret_initialized');
    return;
  }
  const token = await read('TELEGRAM_BOT_TOKEN');
  let body = {};
  let method;
  if (mode === 'set') {
    const url = new URL(process.argv[3]);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/(?:\.cloudfunctions\.net|\.run\.app)$/.test(url.hostname)
    )
      throw new Error();
    body = {
      url: url.href,
      secret_token: await read('TELEGRAM_WEBHOOK_SECRET'),
      allowed_updates: ['message'],
      max_connections: 10,
      drop_pending_updates: false,
    };
    method = 'setWebhook';
  } else method = mode === 'status' ? 'getWebhookInfo' : 'deleteWebhook';
  const response = await fetch(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    },
  );
  const result = await response.json();
  if (!response.ok || result.ok !== true) throw new Error();
  // Upstream descriptions/last_error_message may contain payloads; never print them.
  if (mode === 'status') {
    const url = result.result?.url;
    let safe = 'unrecognized_url';
    if (url === '') safe = 'unset';
    else if (typeof url === 'string') {
      try {
        const parsed = new URL(url);
        if (
          parsed.protocol === 'https:' &&
          !parsed.username &&
          !parsed.password &&
          !parsed.search &&
          !parsed.hash &&
          ((parsed.hostname === `europe-west3-${project}.cloudfunctions.net` &&
            parsed.pathname === '/placesWebhook') ||
            (parsed.hostname.startsWith('placeswebhook-') &&
              parsed.hostname.endsWith('.run.app') &&
              parsed.pathname === '/'))
        )
          safe = parsed.href;
      } catch {
        /* fixed metadata only */
      }
    }
    console.info(
      JSON.stringify({
        ok: true,
        url: safe,
        pendingUpdateCount: Number(result.result?.pending_update_count ?? 0),
        hasDeliveryError: !!result.result?.last_error_date,
      }),
    );
  } else
    console.info(
      JSON.stringify({
        ok: true,
        mode,
        ...(mode === 'set' ? { url: body.url } : {}),
      }),
    );
}
void main().catch(() => {
  console.error(
    'webhook_operation_failed:check_arguments_ADC_secret_IAM_and_bot_configuration',
  );
  process.exitCode = 1;
});
