import { onRequest } from 'firebase-functions/v2/https';
import { defineString } from 'firebase-functions/params';
import { createRuntime } from './runtime.js';
import { handleWebhook } from './webhook.js';
const parameters = Object.fromEntries(
  [
    'WORKSPACE_ID',
    'TELEGRAM_CHAT_ID',
    'TELEGRAM_USER_IDS',
    'TELEGRAM_BOT_USERNAME',
    'OPENAI_MODEL',
    'OPENAI_REASONING_EFFORT',
    'OPENAI_HOST_ID',
  ].map((name) => [name, defineString(name)]),
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
