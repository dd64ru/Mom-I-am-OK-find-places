import { z } from 'zod';
import { GoogleSecrets } from '@places/providers';
import { loadTelegramIdsConfig } from './config.js';
export class TelegramIdsFailure extends Error {
  constructor(
    readonly code:
      | 'telegram_ids_polling_failed'
      | 'telegram_ids_invalid_token'
      | 'telegram_ids_unauthorized'
      | 'telegram_ids_conflict:stop_other_poller',
  ) {
    super(code);
    this.name = 'TelegramIdsFailure';
  }
}
const Sender = z.object({
  id: z.number().int().safe().positive(),
  is_bot: z.boolean(),
  username: z.string().optional(),
  first_name: z.string(),
  last_name: z.string().optional(),
});
const Chat = z.object({
  id: z.number().int().safe(),
  type: z.enum(['group', 'supergroup']),
  title: z.string().optional(),
});
export interface TelegramIdMetadata {
  chatId: number;
  chatType: 'group' | 'supergroup';
  chatTitle?: string;
  userId: number;
  username?: string;
  displayName: string;
  eventKind: 'text' | 'command' | 'image' | 'document' | 'other';
}
// Explicit projection: no copying/spreading of raw messages, captions, media or updates.
export function extractTelegramIdMetadata(
  message: unknown,
  token?: string,
): TelegramIdMetadata | undefined {
  if (!message || typeof message !== 'object') return;
  const m = message as Record<string, unknown>;
  const chat = Chat.safeParse(m.chat);
  const sender = Sender.safeParse(m.from);
  if (!chat.success || !sender.success || sender.data.is_bot) return;
  let eventKind: TelegramIdMetadata['eventKind'] = 'other';
  if (Array.isArray(m.photo) && m.photo.length) eventKind = 'image';
  else if (m.document) eventKind = 'document';
  else if (typeof m.text === 'string') {
    const first = Array.isArray(m.entities) ? m.entities[0] : undefined;
    eventKind =
      first?.type === 'bot_command' && first?.offset === 0 ? 'command' : 'text';
  }
  const label = (value: string | undefined) => {
    const safe = value?.replace(
      /https?:\/\/api\.telegram\.org\/(?:file\/)?bot[^\s"<>]+/gi,
      '[redacted]',
    );
    return token ? safe?.replaceAll(token, '[redacted]') : safe;
  };
  return {
    chatId: chat.data.id,
    chatType: chat.data.type,
    chatTitle: label(chat.data.title),
    userId: sender.data.id,
    username: label(sender.data.username),
    displayName: label(
      [sender.data.first_name, sender.data.last_name].filter(Boolean).join(' '),
    )!,
    eventKind,
  };
}
export class TelegramIdsApi {
  constructor(
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(token))
      throw new TelegramIdsFailure('telegram_ids_invalid_token');
  }
  async getUpdates(
    offset: number | undefined,
    signal: AbortSignal,
  ): Promise<unknown[]> {
    try {
      const response = await this.fetcher(
        `https://api.telegram.org/bot${this.token}/getUpdates`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            offset,
            timeout: 20,
            limit: 100,
            allowed_updates: ['message'],
          }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        },
      );
      if (response.status === 401)
        throw new TelegramIdsFailure('telegram_ids_unauthorized');
      if (response.status === 409)
        throw new TelegramIdsFailure('telegram_ids_conflict:stop_other_poller');
      if (!response.ok)
        throw new TelegramIdsFailure('telegram_ids_polling_failed');
      const payload = await response.json();
      if (
        payload?.ok !== true ||
        !Array.isArray(payload.result) ||
        payload.result.length > 100
      )
        throw new TelegramIdsFailure('telegram_ids_polling_failed');
      return payload.result;
    } catch (error) {
      // No raw API errors/URLs/bodies, including malformed JSON and network error causes.
      if (error instanceof TelegramIdsFailure) throw error;
      throw new TelegramIdsFailure('telegram_ids_polling_failed');
    }
  }
}
export async function pollTelegramIds(
  api: Pick<TelegramIdsApi, 'getUpdates'>,
  print: (metadata: TelegramIdMetadata) => void,
  signal: AbortSignal,
  token?: string,
): Promise<void> {
  let offset: number | undefined;
  while (!signal.aborted) {
    let updates: unknown[];
    try {
      updates = await api.getUpdates(offset, signal);
    } catch (error) {
      if (signal.aborted) return;
      throw error;
    }
    for (const update of updates) {
      if (signal.aborted) return;
      if (!update || typeof update !== 'object') continue;
      const u = update as Record<string, unknown>;
      if (
        typeof u.update_id !== 'number' ||
        !Number.isSafeInteger(u.update_id) ||
        u.update_id < 0 ||
        u.update_id === Number.MAX_SAFE_INTEGER
      )
        throw new TelegramIdsFailure('telegram_ids_polling_failed');
      offset = Math.max(offset ?? 0, u.update_id + 1);
      const metadata = extractTelegramIdMetadata(u.message, token);
      if (metadata) print(metadata);
    }
  }
}
export async function runTelegramIds(
  print: (metadata: TelegramIdMetadata) => void,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const config = loadTelegramIdsConfig(env);
  const token =
    config.SECRET_SOURCE === 'google'
      ? await new GoogleSecrets(config.GOOGLE_CLOUD_PROJECT).read(
          'TELEGRAM_BOT_TOKEN',
        )
      : config.TELEGRAM_BOT_TOKEN!;
  await pollTelegramIds(new TelegramIdsApi(token), print, signal, token);
}
