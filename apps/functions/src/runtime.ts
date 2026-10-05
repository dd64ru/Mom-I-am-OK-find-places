import { CitySessions } from './city-sessions.js';
import { Firestore } from '@google-cloud/firestore';
import {
  DiscoveryService,
  type ImageInput,
  type VisionProvider,
  type SearchProvider,
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
  GooglePlacesPoi,
  googlePlacesAdc,
  FallbackPoi,
  PipelineTelemetry,
} from '@places/providers';
import {
  loadConfig,
  downloadImage,
  MAX_IMAGE_BYTES,
  type AcceptedMessage,
} from '@places/worker';
import { Ingress } from './ingress.js';
import { TelegramApi } from './telegram-api.js';
import { ProcessingStatus } from './processing-status.js';
import { TelegramInteractions } from './interactions.js';
export function createRuntime(env: NodeJS.ProcessEnv) {
  const telemetry = new PipelineTelemetry((event) =>
    console.info(JSON.stringify(event)),
  );
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
  const rawSearch = new OpenAiSearch(
    oauth,
    config.OPENAI_MODEL,
    config.OPENAI_REASONING_EFFORT,
    vision,
  );
  const search: SearchProvider = {
    verify: (recognition, context) =>
      telemetry.measure(
        'web_verification',
        () => rawSearch.verify(recognition, context),
        (result) =>
          result.status === 'verified'
            ? 'ok'
            : result.status === 'no_evidence'
              ? 'no_match'
              : 'unresolved',
        'web_enrichment',
      ),
  };
  const poi = new FallbackPoi(
    new GooglePlacesPoi(
      googlePlacesAdc(config.GOOGLE_CLOUD_PROJECT),
      config.GOOGLE_CLOUD_PROJECT,
      fetch,
      Date.now,
      (event) => console.info(JSON.stringify(event)),
      telemetry,
    ),
    new NominatimPoi(docs, env.NOMINATIM_ENDPOINT || undefined),
    telemetry,
    (code) => console.warn(code),
  );
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
    resolveCityText: (text: Extract<AcceptedMessage, { kind: 'cityText' }>) =>
      new CitySessions(
        docs,
        repository,
        config.WORKSPACE_ID,
        config.chatId,
      ).resolve(text),
    async accept(accepted: AcceptedMessage) {
      if (accepted.kind === 'cityText') return 'done' as const;
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
          text: 'Запрос получен. Просроченные и уже обработанные действия пропускаются.',
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
          const status = new ProcessingStatus(
            docs,
            api,
            config.WORKSPACE_ID,
            config.chatId,
          );
          await status.start(id, record.messageId, 'city');
          return imageSlot(docs, async (assertSlot) => {
            await assertOwned();
            await assertSlot();
            const outcome = await interactions.cityReply(
              accepted,
              promptToken!,
            );
            // A prompt can expire/be superseded while waiting for the global slot.
            if (!outcome) await status.complete(id);
            return outcome;
          });
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
              text: 'Подсказка города или региона обновлена.',
            });
          } else
            await api.call('sendMessage', {
              chat_id: config.chatId,
              text: 'Пришли фото, альбом или документ JPEG/PNG/WebP. Я проверю место и предложу «Добавить», «Изменить город» или «Отмена». Если спрошу город, ответь на сообщение с вопросом. /area <город или регион> задаёт подсказку для группы (до 200 символов). Место сохраняется только после подтверждения.',
            });
          return;
        }
        const status = new ProcessingStatus(
          docs,
          api,
          config.WORKSPACE_ID,
          config.chatId,
        );
        await status.start(id, record.messageId);
        return imageSlot(docs, async (assertSlot) => {
          const budget = AbortSignal.timeout(200_000);
          let result = await repository.getDiscovery(config.WORKSPACE_ID, id);
          if (!result) {
            const provider = await vision();
            const images = await telemetry.measure(
              'image_download',
              async () => {
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
                  if (total > 25 * 1024 * 1024)
                    throw new Error('album_too_large');
                  images.push(image);
                }
                return images;
              },
            );
            await assertOwned();
            const fenced: VisionProvider = {
              name: provider.name,
              async recognize(images, area) {
                budget.throwIfAborted();
                const result = await telemetry.measure('vision', () =>
                  provider.recognize(images, area),
                );
                budget.throwIfAborted();
                await assertOwned();
                await assertSlot();
                return result;
              },
            };
            result = await new DiscoveryService(repository, fenced, {
              search: {
                async verify(recognition, context) {
                  budget.throwIfAborted();
                  const result = await search.verify(recognition, context);
                  budget.throwIfAborted();
                  await assertOwned();
                  await assertSlot();
                  return result;
                },
              },
              poi: {
                async firstPass(recognition, context) {
                  budget.throwIfAborted();
                  const result = await poi.firstPass(recognition, context);
                  budget.throwIfAborted();
                  await assertOwned();
                  await assertSlot();
                  return result;
                },
                async resolve(recognition, verified, context) {
                  budget.throwIfAborted();
                  const result = await poi.resolve(
                    recognition,
                    verified,
                    context,
                  );
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
          if (result.status === 'failed') {
            await status.failure(id);
            return { failureReason: result.failureReason! };
          }
          await status.complete(id);
          return interactions.propose(
            result,
            record.userId ?? accepted.userId,
            record.messageId,
          );
        });
      });
    },
  };
}
