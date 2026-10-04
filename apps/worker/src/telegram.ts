import { MAX_IMAGE_BYTES, imageFromBytes } from './images.js';
import { OpenAiFailure } from '@places/providers';
import { createHash } from 'node:crypto';
import { Bot } from 'grammy';
import type { Message } from 'grammy/types';
import type {
  DiscoveryService,
  PlacesRepository,
  ImageInput,
} from '@places/core';
export interface TelegramPolicy {
  chatId: number;
  userIds: ReadonlySet<number>;
}
export type AcceptedMessage =
  | { kind: 'image'; fileId: string; messageId: number; albumId?: string }
  | {
      kind: 'command';
      command: 'help' | 'area';
      argument: string;
      messageId: number;
    };
export function classify(
  message: Message,
  policy: TelegramPolicy,
  botUsername: string,
): AcceptedMessage | undefined {
  if (
    message.chat.id !== policy.chatId ||
    !message.from ||
    message.from.is_bot ||
    !policy.userIds.has(message.from.id)
  )
    return;
  if (!['group', 'supergroup'].includes(message.chat.type)) return;
  const photo = message.photo?.at(-1);
  if (photo)
    return {
      kind: 'image',
      fileId: photo.file_id,
      messageId: message.message_id,
      albumId: message.media_group_id,
    };
  if (
    message.document &&
    ['image/jpeg', 'image/png', 'image/webp'].includes(
      message.document.mime_type ?? '',
    )
  )
    return {
      kind: 'image',
      fileId: message.document.file_id,
      messageId: message.message_id,
      albumId: message.media_group_id,
    };
  if (
    !message.text ||
    message.entities?.[0]?.type !== 'bot_command' ||
    message.entities[0].offset !== 0
  )
    return;
  const match = /^\/(help|area)(?:@([a-zA-Z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(
    message.text,
  );
  if (
    !match ||
    (match[2] && match[2].toLowerCase() !== botUsername.toLowerCase())
  )
    return;
  return {
    kind: 'command',
    command: match[1] as 'help' | 'area',
    argument: (match[3] ?? '').trim(),
    messageId: message.message_id,
  };
}
export interface ImageBatch {
  id: string;
  messageId: number;
  fileIds: string[];
}
// Telegram sends albums as separate updates. Bound memory; collapse after a quiet interval.
export class AlbumBuffer {
  private readonly pending = new Map<
    string,
    { batch: ImageBatch; timer: ReturnType<typeof setTimeout> }
  >();
  constructor(
    private readonly delayMs: number,
    private readonly emit: (batch: ImageBatch) => Promise<void>,
    private readonly onError: () => void,
  ) {}
  async add(
    chatId: number,
    image: Extract<AcceptedMessage, { kind: 'image' }>,
  ) {
    const id = createHash('sha256')
      .update(`${chatId}:${image.albumId ?? `message-${image.messageId}`}`)
      .digest('hex');
    if (!image.albumId) {
      await this.emit({
        id,
        messageId: image.messageId,
        fileIds: [image.fileId],
      });
      return;
    }
    let entry = this.pending.get(id);
    if (!entry) {
      if (this.pending.size >= 20) throw new Error('album_buffer_full');
      entry = {
        batch: { id, messageId: image.messageId, fileIds: [] },
        timer: setTimeout(() => {}, 0),
      };
      this.pending.set(id, entry);
    }
    clearTimeout(entry.timer);
    if (
      !entry.batch.fileIds.includes(image.fileId) &&
      entry.batch.fileIds.length < 10
    )
      entry.batch.fileIds.push(image.fileId);
    entry.timer = setTimeout(() => {
      this.pending.delete(id);
      void this.emit(entry!.batch).catch(this.onError);
    }, this.delayMs);
  }
  async flush() {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const e of entries) {
      clearTimeout(e.timer);
      await this.emit(e.batch);
    }
  }
}
export async function downloadImage(
  token: string,
  filePath: string,
): Promise<ImageInput> {
  // getFile paths are supplied by Telegram, never AI/user URLs.
  if (!/^[a-zA-Z0-9_./-]+$/.test(filePath) || filePath.includes('..'))
    throw new Error('invalid_telegram_file_path');
  const r = await fetch(
    `https://api.telegram.org/file/bot${token}/${filePath}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (
    !r.ok ||
    !r.body ||
    Number(r.headers.get('content-length') ?? 0) > MAX_IMAGE_BYTES
  )
    throw new Error('image_download_failed');
  const reader = r.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_IMAGE_BYTES) throw new Error('image_too_large');
      parts.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return imageFromBytes(Buffer.concat(parts));
}
export function createTelegramWorker(options: {
  token: string;
  policy: TelegramPolicy;
  workspaceId: string;
  albumWaitMs: number;
  service: DiscoveryService;
  repository: PlacesRepository;
}) {
  const bot = new Bot(options.token);
  let serial = Promise.resolve();
  let outstanding = 0;
  const reportError = (error?: unknown) => {
    console.error(
      error instanceof OpenAiFailure ? error.code : 'image_processing_failed',
    );
  };
  const albums = new AlbumBuffer(
    options.albumWaitMs,
    async (batch) => {
      if (outstanding >= 20) throw new Error('image_queue_full');
      outstanding++;
      const job = serial
        .then(async () => {
          try {
            // Avoid downloading/re-analyzing a completed Telegram source on delivery retry.
            let result = await options.repository.getDiscovery(
              options.workspaceId,
              batch.id,
            );
            if (!result) {
              const images: ImageInput[] = [];
              let total = 0;
              for (const id of batch.fileIds) {
                const file = await bot.api.getFile(id);
                if (!file.file_path || (file.file_size ?? 0) > MAX_IMAGE_BYTES)
                  throw new Error('image_too_large');
                const image = await downloadImage(
                  options.token,
                  file.file_path,
                );
                total += image.bytes.byteLength;
                if (total > 25 * 1024 * 1024)
                  throw new Error('album_too_large');
                images.push(image);
              }
              result = await options.service.ingest({
                id: batch.id,
                workspaceId: options.workspaceId,
                images,
                source: {
                  provider: 'telegram',
                  externalId: `${options.policy.chatId}:${batch.messageId}`,
                  observedAt: new Date().toISOString(),
                },
              });
            }
            const names = result.recognition.clues.map(
              (c) =>
                `${c.name.slice(0, 200)} (${Math.round(c.confidence * 100)}%)`,
            );
            const text = names.length
              ? `Possible places:\n${names.join('\n')}\nGeographic verification and confirmation are pending.`
              : 'No place evidence identified.';
            await bot.api.sendMessage(options.policy.chatId, text, {
              reply_parameters: { message_id: batch.messageId },
            });
          } catch (error) {
            reportError(error);
            await bot.api
              .sendMessage(
                options.policy.chatId,
                'Image processing failed. Retry the images later.',
              )
              .catch(() => {});
          }
        })
        .finally(() => {
          outstanding--;
        });
      serial = job.catch(reportError);
      await job;
    },
    reportError,
  );
  bot.on('message', async (ctx) => {
    // This is the first middleware. Nothing reads captions or logs/stores normal conversation.
    const accepted = classify(ctx.message, options.policy, ctx.me.username);
    if (!accepted) return;
    if (accepted.kind === 'image') {
      await albums.add(ctx.chat.id, accepted);
      return;
    }
    if (accepted.command === 'help') {
      await ctx.reply(
        'Send place images or albums. /area <city or region> sets an optional location hint. Identification is provisional.',
      );
      return;
    }
    if (!accepted.argument || accepted.argument.length > 200) {
      await ctx.reply('Usage: /area <city or region> (up to 200 characters)');
      return;
    }
    await options.repository.setArea(options.workspaceId, accepted.argument);
    await ctx.reply('Area hint updated.');
  });
  // Raw grammy errors can contain requests, tokens, or user content: log fixed codes only.
  bot.catch(() => {
    console.error('telegram_update_failed');
  });
  return {
    bot,
    async drain() {
      await albums.flush();
      await serial;
    },
  };
}
