import { open, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
// Fail closed after a crash: an operator checks that the old owner is stopped before removing the lock.
export async function acquireRuntimeLock(
  directory: string,
): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'owner.lock');
  try {
    const file = await open(path, 'wx', 0o600);
    await file.writeFile(String(process.pid));
    await file.close();
  } catch {
    throw new Error('runtime_already_owned_or_lock_unavailable');
  }
  return async () => {
    await unlink(path);
  };
}
