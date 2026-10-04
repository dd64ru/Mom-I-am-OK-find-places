import { Firestore } from '@google-cloud/firestore';
import { DiscoveryService, type VisionProvider } from '@places/core';
import {
  FirestoreRepository,
  GoogleSecrets,
  OpenAiOAuth,
  FileSessions,
  OpenAiVision,
  GeminiVision,
  FallbackVision,
  acquireRuntimeLock,
} from '@places/providers';
import { loadConfig } from './config.js';
import { createTelegramWorker } from './telegram.js';
async function main() {
  const config = loadConfig();
  const release = await acquireRuntimeLock(config.directory);
  try {
    const secrets = new GoogleSecrets(config.GOOGLE_CLOUD_PROJECT);
    const token =
      config.SECRET_SOURCE === 'google'
        ? await secrets.read('TELEGRAM_BOT_TOKEN')
        : config.TELEGRAM_BOT_TOKEN!;
    const sessions = new FileSessions(config.directory);
    await sessions.hostId();
    const oauth = new OpenAiOAuth(sessions, config.OPENAI_PROFILE);
    // Missing primary authorization is a setup error, never silently switched to Gemini.
    await oauth.accessToken();
    let vision: VisionProvider = new OpenAiVision(oauth, config.OPENAI_MODEL);
    if (config.GEMINI_FALLBACK_ENABLED === 'true') {
      const key =
        config.SECRET_SOURCE === 'google'
          ? await secrets.read('GEMINI_API_KEY')
          : config.GEMINI_API_KEY!;
      vision = new FallbackVision(
        vision,
        new GeminiVision(key, config.GEMINI_MODEL!),
        () => console.warn('gemini_fallback_used'),
      );
    }
    const repository = new FirestoreRepository(
      new Firestore({ projectId: config.GOOGLE_CLOUD_PROJECT }),
    );
    if (!(await repository.getWorkspace(config.WORKSPACE_ID)))
      throw new Error('workspace_missing');
    const worker = createTelegramWorker({
      token,
      policy: { chatId: config.chatId, userIds: config.userIds },
      workspaceId: config.WORKSPACE_ID,
      albumWaitMs: config.ALBUM_WAIT_MS,
      repository,
      service: new DiscoveryService(repository, vision),
    });
    let stopping = false;
    const stop = () => {
      if (!stopping) {
        stopping = true;
        void worker.bot.stop().catch(() => {});
      }
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      await worker.bot.start({
        allowed_updates: ['message'],
        onStart: () => console.info('worker_started'),
      });
    } finally {
      await worker.drain();
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  } finally {
    await release();
  }
}
void main().catch(() => {
  console.error(
    'worker_start_or_runtime_failed:check_configuration_authorization_and_IAM',
  );
  process.exitCode = 1;
});
