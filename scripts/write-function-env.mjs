import { writeFile } from 'node:fs/promises';
import { nominatimEndpoint } from '@places/providers';
import { loadConfig } from '../apps/worker/dist/index.js';
const names = [
  'WORKSPACE_ID',
  'TELEGRAM_CHAT_ID',
  'TELEGRAM_BOT_USERNAME',
  'OPENAI_MODEL',
  'OPENAI_REASONING_EFFORT',
  'OPENAI_HOST_ID',
];
try {
  const values = Object.fromEntries(
    names.map((key) => [key, process.env[key]]),
  );
  loadConfig(values);
  if (
    !/^[A-Za-z0-9_]{1,64}$/.test(values.TELEGRAM_BOT_USERNAME ?? '') ||
    !/^urn:uuid:[a-f0-9-]{36}$/.test(values.OPENAI_HOST_ID ?? '') ||
    names.some(
      (name) => !values[name] || !/^[A-Za-z0-9_:.,-]+$/.test(values[name]),
    )
  )
    throw new Error();
  const endpoint = nominatimEndpoint(
    process.env.NOMINATIM_ENDPOINT || 'https://nominatim.openstreetmap.org',
  );
  await writeFile(
    '.deploy/functions/.env.mom-im-ok-places',
    names.map((name) => `${name}=${values[name]}`).join('\n') +
      `\nNOMINATIM_ENDPOINT=${endpoint}\nGEMINI_FALLBACK_ENABLED=false\n`,
  );
} catch {
  console.error(
    'function_settings_invalid:configure_nonsecret_production_variables',
  );
  process.exitCode = 1;
}
