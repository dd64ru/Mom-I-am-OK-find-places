import { Firestore } from '@google-cloud/firestore';
import {
  DiscoveryService,
  type ImageInput,
  type VisionProvider,
} from '@places/core';
import {
  imageSlot,
  GoogleSecrets,
  FirestoreRepository,
  FirestoreDocuments,
  RefreshLease,
  SecretSessions,
  googleSessionSecrets,
  OpenAiOAuth,
  OpenAiVision,
  GeminiVision,
  FallbackVision,
} from '@places/providers';
import {
  loadConfig,
  downloadImage,
  MAX_IMAGE_BYTES,
  type AcceptedMessage,
} from '@places/worker';
import { Ingress } from './ingress.js';
// Small API adapter sanitizes every Telegram failure; no grammy errors/raw responses escape.
class TelegramApi {
  constructor(private readonly token: string) {}
  async call(method: 'getFile' | 'sendMessage', body: Record<string, unknown>) {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${this.token}/${method}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(20_000),
        },
      );
      const json = await response.json();
      if (!response.ok || json.ok !== true) throw new Error();
      return json.result;
    } catch {
      throw new Error('telegram_request_failed');
    }
  }
}
export function createRuntime(env: NodeJS.ProcessEnv) {
  const config = loadConfig({ ...env, SECRET_SOURCE: 'google' });
  const username = env.TELEGRAM_BOT_USERNAME;
  if (!username || !/^[A-Za-z0-9_]{1,64}$/.test(username))
    throw new Error('telegram_username_required');
  const db = new Firestore({ projectId: config.GOOGLE_CLOUD_PROJECT });
  const docs = new FirestoreDocuments(db),
    secrets = new GoogleSecrets(config.GOOGLE_CLOUD_PROJECT);
  const store = new SecretSessions(
    googleSessionSecrets(config.GOOGLE_CLOUD_PROJECT),
    env.OPENAI_HOST_ID ?? '',
    new RefreshLease(docs),
  );
  const oauth = new OpenAiOAuth(store, 'owner');
  const primary = new OpenAiVision(
    oauth,
    config.OPENAI_MODEL,
    config.OPENAI_REASONING_EFFORT,
  );
  let ready: Promise<VisionProvider> | undefined;
  const vision = () =>
    (ready ??= (async () => {
      await primary.validateModel(); // once per cold instance, never each image batch
      if (config.GEMINI_FALLBACK_ENABLED !== 'true') return primary;
      return new FallbackVision(
        primary,
        new GeminiVision(
          await secrets.read('GEMINI_API_KEY'),
          config.GEMINI_MODEL!,
        ),
        () => console.warn('gemini_fallback_used'),
      );
    })().catch((error) => {
      ready = undefined;
      throw error;
    }));
  const repository = new FirestoreRepository(db),
    ingress = new Ingress(docs, config.WORKSPACE_ID);
  const policy = { chatId: config.chatId, userIds: config.userIds };
  return {
    policy,
    username,
    secret: () => secrets.read('TELEGRAM_WEBHOOK_SECRET'),
    async accept(accepted: AcceptedMessage) {
      const id = await ingress.receive(config.chatId, accepted);
      return ingress.run(id, async (record, assertOwned) => {
        const api = new TelegramApi(await secrets.read('TELEGRAM_BOT_TOKEN'));
        if (accepted.kind === 'command') {
          await assertOwned();
          if (
            accepted.command === 'area' &&
            accepted.argument &&
            accepted.argument.length <= 200
          ) {
            await repository.setArea(config.WORKSPACE_ID, accepted.argument);
            await api.call('sendMessage', {
              chat_id: config.chatId,
              text: 'Area hint updated.',
            });
          } else
            await api.call('sendMessage', {
              chat_id: config.chatId,
              text: 'Send place images or albums. /area <city or region> sets a hint (up to 200 characters). Identification is provisional.',
            });
          return;
        }
        await imageSlot(docs, async (assertSlot) => {
          const budget = AbortSignal.timeout(200_000);
          let result = await repository.getDiscovery(config.WORKSPACE_ID, id);
          if (!result) {
            const provider = await vision();
            const images: ImageInput[] = [];
            let total = 0;
            for (const fileId of record.fileIds) {
              const file = await api.call('getFile', { file_id: fileId });
              if (
                typeof file?.file_path !== 'string' ||
                (file.file_size ?? 0) > MAX_IMAGE_BYTES
              )
                throw new Error('image_download_failed');
              const image = await downloadImage(
                await secrets.read('TELEGRAM_BOT_TOKEN'),
                file.file_path,
                budget,
              );
              total += image.bytes.byteLength;
              if (total > 25 * 1024 * 1024) throw new Error('album_too_large');
              images.push(image);
            }
            await assertOwned();
            const fenced: VisionProvider = {
              name: provider.name,
              async recognize(images, area) {
                budget.throwIfAborted();
                const result = await provider.recognize(images, area);
                budget.throwIfAborted();
                await assertOwned();
                await assertSlot();
                return result;
              },
            };
            result = await new DiscoveryService(repository, fenced).ingest({
              id,
              workspaceId: config.WORKSPACE_ID,
              images,
              source: {
                provider: 'telegram',
                externalId: `${config.chatId}:${record.messageId}`,
                observedAt: new Date().toISOString(),
              },
            });
          }
          await assertOwned();
          const names = result.recognition.clues.map(
            (c) =>
              `${c.name.slice(0, 200)} (${Math.round(c.confidence * 100)}%)`,
          );
          await api.call('sendMessage', {
            chat_id: config.chatId,
            text: names.length
              ? `Possible places:\n${names.join('\n')}\nGeographic verification and confirmation are pending.`
              : 'No place evidence identified.',
            reply_parameters: { message_id: record.messageId },
          });
        });
      });
    },
  };
}
