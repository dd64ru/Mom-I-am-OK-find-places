import { MAX_IMAGE_BYTES, imageFromBytes } from './images.js';
import type { Message } from 'grammy/types';
import type { ImageInput } from '@places/core';
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
export async function downloadImage(
  token: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<ImageInput> {
  // getFile paths are supplied by Telegram, never AI/user URLs.
  if (!/^[a-zA-Z0-9_./-]+$/.test(filePath) || filePath.includes('..'))
    throw new Error('invalid_telegram_file_path');
  const r = await fetch(
    `https://api.telegram.org/file/bot${token}/${filePath}`,
    {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    },
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
