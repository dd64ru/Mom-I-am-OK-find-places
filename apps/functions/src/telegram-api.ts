import { z } from 'zod';
export interface TelegramTransport {
  call(
    method:
      | 'getFile'
      | 'sendMessage'
      | 'sendVenue'
      | 'sendLocation'
      | 'editMessageReplyMarkup'
      | 'answerCallbackQuery',
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}
export class TelegramApi implements TelegramTransport {
  constructor(private readonly token: string) {}
  async call(
    method: Parameters<TelegramTransport['call']>[0],
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${this.token}/${method}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        },
      );
      const payload = await response.json();
      if (
        method === 'editMessageReplyMarkup' &&
        response.status === 400 &&
        payload?.description === 'Bad Request: message is not modified'
      )
        return {};
      if (
        method === 'answerCallbackQuery' &&
        response.status === 400 &&
        payload?.description ===
          'Bad Request: query is too old and response timeout expired or query ID is invalid'
      )
        return {};
      const json = z
        .object({ ok: z.literal(true), result: z.unknown() })
        .parse(payload);
      if (!response.ok) throw new Error();
      if (method === 'getFile')
        return z
          .object({
            file_path: z.string().min(1).max(512),
            file_size: z.number().nonnegative().optional(),
          })
          .parse(json.result);
      if (
        method === 'sendMessage' ||
        method === 'sendVenue' ||
        method === 'sendLocation'
      )
        return z
          .object({ message_id: z.number().int().safe().positive() })
          .parse(json.result);
      return {};
    } catch {
      throw new Error('telegram_request_failed');
    }
  }
}
