import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
// Import/discovery only: handlers are never invoked and no credentials are used.
export async function smokeFunctionPackage(directory, target) {
  assert.ok(['webhook', 'feed'].includes(target));
  const pkg = JSON.parse(
    await readFile(resolve(directory, 'package.json'), 'utf8'),
  );
  const release = JSON.parse(
    await readFile(resolve(directory, 'RELEASE.json'), 'utf8'),
  );
  assert.equal(pkg.main, `dist/${target}-entry.js`);
  assert.equal(release.target, target);
  const exports = await import(
    pathToFileURL(resolve(directory, pkg.main)).href
  );
  const functions = Object.entries(exports).filter(
    ([, value]) => value?.__endpoint,
  );
  assert.deepEqual(
    functions.map(([name]) => name),
    [target === 'feed' ? 'placesFeed' : 'placesWebhook'],
  );
  const params = globalThis[
    Symbol.for('firebase-functions:params:declaredParams')
  ]
    .map((p) => p.name)
    .sort();
  assert.deepEqual(
    params,
    (target === 'feed'
      ? [
          'WORKSPACE_ID',
          'PLACES_FEED_ENABLED',
          'PLACES_FEED_URL_TOKENS_ENABLED',
        ]
      : [
          'WORKSPACE_ID',
          'TELEGRAM_CHAT_ID',
          'TELEGRAM_BOT_USERNAME',
          'OPENAI_MODEL',
          'OPENAI_REASONING_EFFORT',
          'OPENAI_HOST_ID',
          'NOMINATIM_ENDPOINT',
        ]
    ).sort(),
  );
  console.info(`production_package_ok:${target}`);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    await smokeFunctionPackage(process.argv[2], process.argv[3]);
  } catch {
    console.error('production_package_smoke_failed');
    process.exitCode = 1;
  }
}
