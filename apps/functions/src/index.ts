import { onRequest } from 'firebase-functions/v2/https';
import { defineString } from 'firebase-functions/params';
import { createRuntime } from './runtime.js';
import { handleWebhook } from './webhook.js';
import { handleFeed, type FeedDependencies } from './feed.js';
import { createFeedRuntime } from './feed-runtime.js';
const parameters = Object.fromEntries(
  [
    'WORKSPACE_ID',
    'TELEGRAM_CHAT_ID',
    'TELEGRAM_BOT_USERNAME',
    'OPENAI_MODEL',
    'OPENAI_REASONING_EFFORT',
    'OPENAI_HOST_ID',
    'NOMINATIM_ENDPOINT',
  ].map((name) => [
    name,
    defineString(
      name,
      name === 'NOMINATIM_ENDPOINT'
        ? { default: 'https://nominatim.openstreetmap.org' }
        : {},
    ),
  ]),
);
export const functionOptions = {
  region: 'europe-west3',
  minInstances: 0,
  maxInstances: 2,
  concurrency: 16,
  cpu: 1,
  memory: '512MiB' as const,
  timeoutSeconds: 300,
  invoker: 'public' as const,
  serviceAccount: 'places-runtime@mom-im-ok-places.iam.gserviceaccount.com',
};
let runtime: ReturnType<typeof createRuntime> | undefined;
export const placesWebhook = onRequest(functionOptions, async (req, res) => {
  try {
    runtime ??= createRuntime({
      ...process.env,
      ...Object.fromEntries(
        Object.entries(parameters).map(([name, param]) => [
          name,
          param.value(),
        ]),
      ),
    });
    const response = await handleWebhook(
      {
        method: req.method,
        contentType: req.get('content-type') ?? '',
        secret: req.get('x-telegram-bot-api-secret-token'),
        get rawBody() {
          return req.rawBody;
        },
      },
      runtime,
    );
    res.status(response.status).type('text/plain').send(response.body);
  } catch {
    console.error(
      'webhook_processing_failed:check_configuration_IAM_and_authorization',
    );
    res.status(503).type('text/plain').send('processing_unavailable');
  }
});

const feedEnabled = defineString('PLACES_FEED_ENABLED', { default: 'false' });
const feedUrlTokens = defineString('PLACES_FEED_URL_TOKENS_ENABLED', {
  default: 'false',
});
export const feedFunctionOptions = {
  region: 'europe-west3',
  minInstances: 0,
  maxInstances: 1,
  concurrency: 2,
  cpu: 1,
  memory: '256MiB' as const,
  timeoutSeconds: 60,
  invoker: 'public' as const,
  serviceAccount: 'places-runtime@mom-im-ok-places.iam.gserviceaccount.com',
};
let feedRuntime: FeedDependencies | undefined;
export const placesFeed = onRequest(feedFunctionOptions, async (req, res) => {
  // Disabled by default; the existing webhook-only deployment workflow stays unchanged.
  res.set({
    'Cache-Control': 'private, no-cache, max-age=0, must-revalidate',
    'Referrer-Policy': 'no-referrer',
  });
  if (req.method !== 'GET') {
    res
      .set('Allow', 'GET')
      .status(405)
      .type('text/plain')
      .send('method_not_allowed');
    return;
  }
  if (feedEnabled.value() !== 'true') {
    res.status(503).type('text/plain').send('feed_unavailable');
    return;
  }
  try {
    feedRuntime ??= createFeedRuntime({
      ...process.env,
      WORKSPACE_ID: parameters.WORKSPACE_ID!.value(),
      PLACES_FEED_URL_TOKENS_ENABLED: feedUrlTokens.value(),
    });
    const response = await handleFeed(
      {
        method: req.method,
        query: req.query,
        authorization: req.get('authorization'),
        ifNoneMatch: req.get('if-none-match'),
      },
      feedRuntime,
    );
    res.set(response.headers).status(response.status).send(response.body);
  } catch {
    res.status(503).type('text/plain').send('feed_unavailable');
  }
});
