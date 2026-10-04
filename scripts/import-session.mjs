import { readFile } from 'node:fs/promises';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { Firestore } from '@google-cloud/firestore';
import {
  decodeSession,
  encodeSession,
} from '../packages/providers/dist/index.js';
async function main() {
  if (
    process.argv.length !== 3 ||
    process.env.CONFIRM_WEBHOOK_STOPPED !== 'true'
  )
    throw new Error();
  const session = decodeSession(await readFile(process.argv[2]));
  const project = process.env.GOOGLE_CLOUD_PROJECT ?? 'mom-im-ok-places';
  const secrets = new SecretManagerServiceClient();
  const [version] = await secrets.addSecretVersion({
    parent: `projects/${project}/secrets/OPENAI_SIWC_SESSION`,
    payload: { data: encodeSession(session) },
  });
  // Only after successful durable replacement and after all old requests have drained.
  await new Firestore({ projectId: project })
    .doc('_runtime/openai-refresh')
    .set({ expiresAt: 0, blocked: false, sessionVersion: version.name });
  console.info('siwc_session_imported:serverless_is_sole_refresh_owner');
}
void main().catch(() => {
  console.error('siwc_import_failed:check_profile_ADC_and_stopped_runtime');
  process.exitCode = 1;
});
