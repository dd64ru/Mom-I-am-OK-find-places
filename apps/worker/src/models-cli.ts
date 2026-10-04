import {
  FileSessions,
  OpenAiOAuth,
  listOpenAiModels,
  acquireRuntimeLock,
} from '@places/providers';
import { loadOAuthConfig } from './config.js';
async function main() {
  const c = loadOAuthConfig();
  const release = await acquireRuntimeLock(c.directory);
  try {
    const oauth = new OpenAiOAuth(new FileSessions(c.directory), c.profile);
    for (const model of await listOpenAiModels(oauth))
      console.info(`${model.slug}\t${model.display_name}`);
  } finally {
    await release();
  }
}
void main().catch(() => {
  console.error('model_discovery_failed:check_authorization');
  process.exitCode = 1;
});
