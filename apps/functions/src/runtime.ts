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
  OpenAiSearch,
  NominatimPoi,
} from '@places/providers';
import {
  loadConfig,
  downloadImage,
  MAX_IMAGE_BYTES,
  type AcceptedMessage,
} from '@places/worker';
import { Ingress } from './ingress.js';
import { TelegramApi } from './telegram-api.js';
import { TelegramInteractions } from './interactions.js';
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
  const policy = { chatId: config.chatId };
  const search = new OpenAiSearch(
    oauth,
    config.OPENAI_MODEL,
    config.OPENAI_REASONING_EFFORT,
    vision,
  );
  const poi = new NominatimPoi(docs, env.NOMINATIM_ENDPOINT || undefined);
  const unusedVision: VisionProvider = {
    name: 'stored-recognition',
    recognize: async () => {
      throw new Error('city_edit_must_not_run_vision');
    },
  };
  return {
    policy,
    username,
    secret: () => secrets.read('TELEGRAM_WEBHOOK_SECRET'),
    async accept(accepted: AcceptedMessage) {
      const api = new TelegramApi(await secrets.read('TELEGRAM_BOT_TOKEN'));
      const interactionService = new DiscoveryService(
        repository,
        unusedVision,
        { search, poi },
      );
      const interactions = new TelegramInteractions(
        docs,
        repository,
        interactionService,
        api,
        config.WORKSPACE_ID,
        config.chatId,
      );
      const promptToken =
        accepted.kind === 'cityReply'
          ? await interactions.canReply(accepted)
          : undefined;
      if (accepted.kind === 'cityReply' && !promptToken) return 'done' as const;
      if (accepted.kind === 'callback') {
        // Acknowledge on every delivery, including duplicates/busy callbacks.
        await api.call('answerCallbackQuery', {
          callback_query_id: accepted.callbackId,
          text: 'Received. Expired or already handled actions will be ignored.',
        });
        if (!(await interactions.canCallback(accepted))) return 'done' as const;
      }
      const id = await ingress.receive(config.chatId, accepted);
      return ingress.run(id, async (record, assertOwned) => {
        if (accepted.kind === 'callback') {
          await assertOwned();
          await interactions.callback(accepted, true);
          return;
        }
        if (accepted.kind === 'cityReply') {
          await imageSlot(docs, async (assertSlot) => {
            await assertOwned();
            await assertSlot();
            await interactions.cityReply(accepted, promptToken!);
          });
          return;
        }
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
              text: 'Send a photo, album or JPEG/PNG/WebP document. I verify the place and propose Confirm / Change city / Cancel. Reply to the city prompt if asked. /area <city or region> sets an optional workspace hint (up to 200 characters). Only confirmation saves a Place.',
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
                Number(file.file_size ?? 0) > MAX_IMAGE_BYTES
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
            result = await new DiscoveryService(repository, fenced, {
              search: {
                async verify(recognition, area) {
                  budget.throwIfAborted();
                  const result = await search.verify(recognition, area);
                  budget.throwIfAborted();
                  await assertOwned();
                  await assertSlot();
                  return result;
                },
              },
              poi: {
                async resolve(recognition, verified, area) {
                  budget.throwIfAborted();
                  const result = await poi.resolve(recognition, verified, area);
                  budget.throwIfAborted();
                  await assertOwned();
                  await assertSlot();
                  return result;
                },
              },
            }).ingest({
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
          if (result.revision === 0)
            result = await interactionService.resolve(result);
          await assertOwned();
          await assertSlot();
          await interactions.propose(
            result,
            record.userId ?? accepted.userId,
            record.messageId,
          );
        });
      });
    },
  };
}
