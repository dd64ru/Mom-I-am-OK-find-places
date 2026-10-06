import { onRequest } from 'firebase-functions/v2/https';
import { defineString } from 'firebase-functions/params';
import { handleFeed, type FeedDependencies } from './feed.js';
import { createFeedRuntime } from './feed-runtime.js';
const workspace = defineString('WORKSPACE_ID');
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
      WORKSPACE_ID: workspace.value(),
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
