import { chmod, lstat, mkdir } from 'node:fs/promises';
import { FileSessions, acquireRuntimeLock } from '@places/providers';
import { loadOAuthConfig } from './config.js';
async function main() {
  const config = loadOAuthConfig();
  await mkdir(config.directory, { recursive: true, mode: 0o700 });
  const directory = await lstat(config.directory);
  if (!directory.isDirectory() || directory.isSymbolicLink())
    throw new Error('invalid_directory');
  await chmod(config.directory, 0o700);
  const release = await acquireRuntimeLock(config.directory);
  try {
    const sessions = new FileSessions(config.directory);
    await sessions.hostId(); // creates/reuses only host.json; never reads an account profile
    await chmod(config.directory, 0o700);
    const state = await lstat(config.directory);
    if (!state.isDirectory() || state.isSymbolicLink())
      throw new Error('invalid_directory');
    console.info(
      JSON.stringify({
        initialized: true,
        directory: config.directory,
        hostIdentityPresent: true,
        ownerUid: state.uid,
        permissions: (state.mode & 0o777).toString(8),
      }),
    );
  } finally {
    await release();
  }
}
void main().catch(() => {
  console.error(
    'runtime_init_failed:check_directory_ownership_and_session_lock',
  );
  process.exitCode = 1;
});
