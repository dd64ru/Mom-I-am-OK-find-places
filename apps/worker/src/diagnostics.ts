import { OpenAiFailure } from '@places/providers';
import { SmokeImageFailure } from './images.js';
import { TelegramIdsFailure } from './telegram-ids.js';
export function diagnosticCode(
  error: unknown,
  command: 'vision:smoke' | 'telegram:ids',
): string {
  // Only locally constructed, typed diagnostic codes are printable. No message/stack/cause serialization.
  if (
    error instanceof OpenAiFailure ||
    error instanceof SmokeImageFailure ||
    error instanceof TelegramIdsFailure
  )
    return error.code;
  return command === 'vision:smoke'
    ? 'vision_smoke_failed:check_configuration_authorization_and_image'
    : 'telegram_ids_failed:check_configuration_token_and_access';
}
