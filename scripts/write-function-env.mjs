import { writeFile } from 'node:fs/promises';
import { IdSchema } from '@places/schemas';
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
  const args = process.argv.slice(2);
  const feed =
    args.length === 2 && args[0] === '--target' && args[1] === 'feed';
  if (args.length && !feed) throw new Error();
  const values = Object.fromEntries(
    names.map((key) => [key, process.env[key]]),
  );
  if (feed) {
    const workspace = IdSchema.parse(values.WORKSPACE_ID);
    await writeFile(
      '.deploy/functions/.env.mom-im-ok-places',
      `WORKSPACE_ID=${workspace}\nPLACES_FEED_ENABLED=true\nPLACES_FEED_URL_TOKENS_ENABLED=false\n`,
    );
  } else {
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
        // Safe dormant defaults; webhook packaging does not export the feed.
        `\nNOMINATIM_ENDPOINT=${endpoint}\nGEMINI_FALLBACK_ENABLED=false\nPLACES_FEED_ENABLED=false\nPLACES_FEED_URL_TOKENS_ENABLED=false\n`,
    );
  }
} catch {
  console.error(
    'function_settings_invalid:configure_nonsecret_production_variables',
  );
  process.exitCode = 1;
}
