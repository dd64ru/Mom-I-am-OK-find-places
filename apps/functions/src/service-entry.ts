import { onRequest } from 'firebase-functions/v2/https';
import { defineString } from 'firebase-functions/params';
import { ServiceRequestSchema } from '@places/core';
import { createServiceRuntime } from './service-runtime.js';
const enabled = defineString('PLACES_SERVICE_ENABLED', { default: 'false' });
const params = Object.fromEntries(
  [
    'WORKSPACE_ID',
    'OPENAI_MODEL',
    'OPENAI_REASONING_EFFORT',
    'OPENAI_HOST_ID',
  ].map((name) => [name, defineString(name)]),
);
export const serviceFunctionOptions = {
  region: 'europe-west3',
  minInstances: 0,
  maxInstances: 2,
  concurrency: 2,
  memory: '512MiB' as const,
  timeoutSeconds: 300,
  // Cloud Run validates the OIDC audience and IAM invoker before application code.
  // Owner must grant only the Mom-I-am-OK backend runtime identity; no public invoker.
  invoker: 'private' as const,
  serviceAccount: 'places-runtime@mom-im-ok-places.iam.gserviceaccount.com',
};
let runtime: ReturnType<typeof createServiceRuntime> | undefined;
export const placesService = onRequest(
  serviceFunctionOptions,
  async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }
    if (enabled.value() !== 'true') {
      res.status(503).json({ error: 'service_unavailable' });
      return;
    }
    if (req.rawBody.length > 32 * 1024 || !req.is('application/json')) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const parsed = ServiceRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    try {
      runtime ??= createServiceRuntime({
        ...process.env,
        ...Object.fromEntries(
          Object.entries(params).map(([name, param]) => [name, param.value()]),
        ),
      });
      res.status(200).json(await runtime.execute(parsed.data));
    } catch (error) {
      const conflict =
        error instanceof Error &&
        [
          'stale_revision',
          'idempotency_conflict',
          'invalid_selection',
        ].includes(error.message);
      console.warn(
        JSON.stringify({
          event: 'service_request',
          outcome: conflict ? 'conflict' : 'unavailable',
        }),
      );
      res.status(conflict ? 409 : 503).json({
        error: conflict
          ? 'stale_or_conflicting_request'
          : 'service_unavailable',
      });
    }
  },
);
