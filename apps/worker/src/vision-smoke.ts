import {
  FileSessions,
  OpenAiOAuth,
  OpenAiVision,
  acquireRuntimeLock,
} from '@places/providers';
import type { Recognition } from '@places/schemas';
import { loadVisionConfig } from './config.js';
import { loadSmokeImage } from './images.js';
export async function runVisionSmoke(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<Recognition> {
  const config = loadVisionConfig(env);
  // Reject unsupported/oversized local files before credentials or network access.
  const image = await loadSmokeImage(args);
  const release = await acquireRuntimeLock(config.directory);
  try {
    const sessions = new FileSessions(config.directory);
    await sessions.hostId();
    const oauth = new OpenAiOAuth(sessions, config.profile);
    const vision = new OpenAiVision(
      oauth,
      config.OPENAI_MODEL,
      config.OPENAI_REASONING_EFFORT,
    );
    await vision.validateModel();
    // Intentionally no fallback, database, Telegram, or Google credential access.
    return (await vision.recognize([image])).recognition;
  } finally {
    await release();
  }
}
