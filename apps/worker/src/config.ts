import { z } from 'zod';
import { resolve } from 'node:path';
import { OpenAiReasoningEffortSchema } from '@places/providers';
import { IdSchema } from '@places/schemas';
const CommonSchema = z.object({
  OPENAI_HOST_ID: z
    .string()
    .regex(/^urn:uuid:[a-f0-9-]{36}$/)
    .optional(),
  OPENAI_SESSION_DIR: z.string().min(1).default('.credentials'),
  OPENAI_PROFILE: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,64}$/)
    .default('owner'),
});
export function loadOAuthConfig(env: NodeJS.ProcessEnv = process.env) {
  const data = CommonSchema.safeParse(env);
  if (!data.success) throw new Error('invalid_oauth_configuration');
  return {
    directory: resolve(data.data.OPENAI_SESSION_DIR),
    profile: data.data.OPENAI_PROFILE,
    hostId: data.data.OPENAI_HOST_ID,
  };
}
const OpenAiSettings = {
  OPENAI_MODEL: z.string().min(1),
  OPENAI_REASONING_EFFORT: OpenAiReasoningEffortSchema.default('low'),
};
const TelegramSecretSettings = {
  GOOGLE_CLOUD_PROJECT: z
    .string()
    .regex(/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/)
    .default('mom-im-ok-places'),
  SECRET_SOURCE: z.enum(['google', 'env']).default('google'),
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
};
const VisionSchema = CommonSchema.extend(OpenAiSettings);
export function loadVisionConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = VisionSchema.safeParse(env);
  if (!parsed.success)
    throw new Error(
      'invalid_vision_configuration:check_session_model_and_reasoning_effort',
    );
  return {
    ...parsed.data,
    directory: resolve(parsed.data.OPENAI_SESSION_DIR),
    profile: parsed.data.OPENAI_PROFILE,
  };
}
const TelegramSecretSchema = z
  .object(TelegramSecretSettings)
  .superRefine((v, ctx) => {
    if (v.SECRET_SOURCE === 'env' && !v.TELEGRAM_BOT_TOKEN)
      ctx.addIssue({
        code: 'custom',
        path: ['TELEGRAM_BOT_TOKEN'],
        message: 'required',
      });
  });
export function loadTelegramIdsConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = TelegramSecretSchema.safeParse(env);
  if (!parsed.success)
    throw new Error(
      'invalid_telegram_ids_configuration:check_secret_source_and_token',
    );
  return parsed.data;
}
const WorkerSchema = CommonSchema.extend({
  ...OpenAiSettings,
  ...TelegramSecretSettings,
  WORKSPACE_ID: IdSchema,
  TELEGRAM_CHAT_ID: z.string().regex(/^-\d+$/),
  TELEGRAM_USER_IDS: z.string().regex(/^\d+(,\d+)*$/),
  GEMINI_FALLBACK_ENABLED: z.enum(['true', 'false']).default('false'),
  GEMINI_MODEL: z
    .string()
    .regex(/^[a-zA-Z0-9._-]+$/)
    .optional(),
  GEMINI_API_KEY: z.string().min(1).optional(),
  ALBUM_WAIT_MS: z.coerce.number().int().min(500).max(5000).default(1500),
}).superRefine((v, ctx) => {
  if (v.GEMINI_FALLBACK_ENABLED === 'true' && !v.GEMINI_MODEL)
    ctx.addIssue({
      code: 'custom',
      path: ['GEMINI_MODEL'],
      message: 'required',
    });
  if (
    v.SECRET_SOURCE === 'env' &&
    (!v.TELEGRAM_BOT_TOKEN ||
      (v.GEMINI_FALLBACK_ENABLED === 'true' && !v.GEMINI_API_KEY))
  )
    ctx.addIssue({
      code: 'custom',
      path: ['SECRET_SOURCE'],
      message: 'local secrets required',
    });
});
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const normalized = Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      value === '' && key !== 'OPENAI_REASONING_EFFORT' ? undefined : value,
    ]),
  );
  const parsed = WorkerSchema.safeParse(normalized);
  // Zod issue values must not leak configuration/secrets into diagnostics.
  if (!parsed.success)
    throw new Error(
      `invalid_configuration:${[...new Set(parsed.error.issues.map((i) => i.path.join('.')))].join(',')}`,
    );
  const d = parsed.data;
  const users = d.TELEGRAM_USER_IDS.split(',').map(Number);
  const chatId = Number(d.TELEGRAM_CHAT_ID);
  if (
    !Number.isSafeInteger(chatId) ||
    users.some((u) => !Number.isSafeInteger(u) || u <= 0)
  )
    throw new Error('invalid_telegram_ids');
  return {
    ...d,
    directory: resolve(d.OPENAI_SESSION_DIR),
    chatId,
    userIds: new Set(users),
  };
}
