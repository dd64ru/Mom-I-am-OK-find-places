import { OpenAiFailure, GooglePlacesFailure } from '@places/providers';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  classify,
  type AcceptedMessage,
  type TelegramPolicy,
} from '@places/worker';
import type { Message } from 'grammy/types';
const Identity = z.object({
  message_id: z.number().int().safe().nonnegative(),
  chat: z.object({
    id: z.number().int().safe(),
    type: z.enum(['group', 'supergroup']),
  }),
  from: z.object({
    id: z.number().int().safe().positive(),
    is_bot: z.boolean(),
  }),
});
const Media = z.object({ file_id: z.string().min(1).max(512) });
const Fields = Identity.extend({
  photo: z.array(Media).max(10).optional(),
  document: Media.extend({
    mime_type: z.string().max(100).optional(),
  }).optional(),
  media_group_id: z.string().max(128).optional(),
  text: z.string().max(4096).optional(),
  reply_to_message: z
    .object({ message_id: z.number().int().safe().nonnegative() })
    .optional(),
  entities: z
    .array(
      z.object({
        type: z.string().max(64),
        offset: z.number().int(),
        length: z.number().int(),
      }),
    )
    .max(100)
    .optional(),
});
export function projectUpdate(
  raw: unknown,
  policy: TelegramPolicy,
  username: string,
  allowCityText = false,
): AcceptedMessage | undefined {
  if (!raw || typeof raw !== 'object') return;
  const update = raw as Record<string, unknown>;
  if (!Number.isSafeInteger(update.update_id) || Number(update.update_id) < 0)
    return;
  if (update.callback_query !== undefined) {
    const callback = z
      .object({
        id: z.string().min(1).max(128),
        from: z.object({
          id: z.number().int().safe().positive(),
          is_bot: z.boolean(),
        }),
        message: z.object({
          message_id: z.number().int().safe().nonnegative(),
          date: z.number().int().positive(),
          chat: Identity.shape.chat,
        }),
        data: z.string().max(64),
        inline_message_id: z.never().optional(),
      })
      .safeParse(update.callback_query);
    if (
      !callback.success ||
      callback.data.from.is_bot ||
      callback.data.message.chat.id !== policy.chatId
    )
      return;
    const match = /^p:([a-f0-9]{32}):([cexsazqbr])$/.exec(callback.data.data);
    if (!match)
      return {
        kind: 'callback',
        callbackId: callback.data.id,
        token: '',
        action: 'cancel',
        messageId: callback.data.message.message_id,
        userId: callback.data.from.id,
      };
    return {
      kind: 'callback',
      callbackId: callback.data.id,
      token: match[1]!,
      action:
        match[2] === 'q'
          ? 'search'
          : match[2] === 'b'
            ? 'brands'
            : match[2] === 'r'
              ? 'related'
              : match[2] === 'c'
                ? 'confirm'
                : match[2] === 'e'
                  ? 'city'
                  : match[2] === 'a'
                    ? 'all'
                    : match[2] === 'z'
                      ? 'clear'
                      : match[2] === 's'
                        ? 'select'
                        : 'cancel',
      messageId: callback.data.message.message_id,
      userId: callback.data.from.id,
    };
  }
  const identity = Identity.safeParse(update.message);
  if (
    !identity.success ||
    identity.data.chat.id !== policy.chatId ||
    identity.data.from.is_bot
  )
    return;
  const parsed = Fields.safeParse(update.message);
  if (!parsed.success) return;
  return classify(parsed.data as Message, policy, username, allowCityText);
}
export interface Delivery {
  method: string;
  contentType: string;
  secret: string | undefined;
  rawBody: Buffer;
}
export async function handleWebhook(
  request: Delivery,
  dependencies: {
    secret: () => Promise<string>;
    policy: TelegramPolicy;
    username: string;
    accept: (message: AcceptedMessage) => Promise<'done' | 'retry'>;
    resolveCityText?: (
      message: Extract<AcceptedMessage, { kind: 'cityText' }>,
    ) => Promise<Extract<AcceptedMessage, { kind: 'cityReply' }> | undefined>;
  },
): Promise<{ status: number; body: string }> {
  try {
    if (request.method !== 'POST')
      return { status: 405, body: 'method_not_allowed' };
    if (!/^application\/json(?:\s*;|$)/i.test(request.contentType))
      return { status: 415, body: 'unsupported_content_type' };
    // Check authentication before reading/parsing rawBody or message fields.
    if (!request.secret || !/^[A-Za-z0-9_-]{1,256}$/.test(request.secret))
      return { status: 403, body: 'delivery_rejected' };
    const expected = await dependencies.secret();
    const supplied = Buffer.from(request.secret),
      known = Buffer.from(expected);
    if (
      !known.length ||
      supplied.length !== known.length ||
      !timingSafeEqual(supplied, known)
    )
      return { status: 403, body: 'delivery_rejected' };
    if (request.rawBody.byteLength > 256 * 1024)
      return { status: 413, body: 'update_too_large' };
    let update: unknown;
    try {
      update = JSON.parse(request.rawBody.toString('utf8'));
    } catch {
      return { status: 400, body: 'invalid_update' };
    }
    let accepted = projectUpdate(
      update,
      dependencies.policy,
      dependencies.username,
    );
    if (!accepted && dependencies.resolveCityText) {
      const text = projectUpdate(
        update,
        dependencies.policy,
        dependencies.username,
        true,
      );
      if (text?.kind === 'cityText')
        accepted = await dependencies.resolveCityText(text);
    }
    if (!accepted || accepted.kind === 'cityText')
      return { status: 200, body: 'ignored' };
    const result = await dependencies.accept(accepted);
    return result === 'done'
      ? { status: 200, body: 'ok' }
      : { status: 503, body: 'retry_later' };
  } catch (error) {
    console.error(safeDiagnostic(error));
    return { status: 503, body: 'processing_unavailable' };
  }
}

export function safeDiagnostic(error: unknown): string {
  if (error instanceof OpenAiFailure) return error.code;
  if (error instanceof GooglePlacesFailure) return error.code;
  const allowed = new Set([
    'poi_lookup_failed',
    'poi_rate_busy',
    'poi_daily_limit',
    'poi_result_invalid',
    'openai_reauthorization_required',
    'openai_refresh_busy',
    'openai_refresh_failed',
    'openai_refresh_outcome_unknown:reauthorization_required',
    'openai_refresh_response_invalid:reauthorization_required',
    'openai_session_invalid',
    'openai_session_unavailable',
    'openai_session_save_failed:reauthorization_may_be_required',
  ]);
  return error instanceof Error && allowed.has(error.message)
    ? error.message
    : 'webhook_processing_failed:check_configuration_IAM_and_authorization';
}
