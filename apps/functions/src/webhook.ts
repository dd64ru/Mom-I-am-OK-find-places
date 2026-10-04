import { OpenAiFailure } from '@places/providers';
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
): AcceptedMessage | undefined {
  if (!raw || typeof raw !== 'object') return;
  const update = raw as Record<string, unknown>;
  if (!Number.isSafeInteger(update.update_id) || Number(update.update_id) < 0)
    return;
  const identity = Identity.safeParse(update.message);
  if (
    !identity.success ||
    identity.data.chat.id !== policy.chatId ||
    identity.data.from.is_bot ||
    !policy.userIds.has(identity.data.from.id)
  )
    return;
  const parsed = Fields.safeParse(update.message);
  if (!parsed.success) return;
  return classify(parsed.data as Message, policy, username);
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
    const accepted = projectUpdate(
      update,
      dependencies.policy,
      dependencies.username,
    );
    if (!accepted) return { status: 200, body: 'ignored' };
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
  const allowed = new Set([
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
