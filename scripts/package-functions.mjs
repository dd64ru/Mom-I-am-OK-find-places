import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
export async function packageFunctions(
  root,
  output,
  commit,
  target = 'webhook',
) {
  if (!['webhook', 'feed'].includes(target)) throw new Error('invalid_target');
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('invalid_commit');
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length)
    throw new Error('functions_destination_not_empty');
  const pkg = JSON.parse(
    await readFile(join(root, 'apps/functions/package.json'), 'utf8'),
  );
  pkg.name = 'places-production';
  // Firebase discovers only this function and its parameters, even in a shared codebase.
  pkg.main = `dist/${target}-entry.js`;
  pkg.dependencies = { ...pkg.dependencies };
  for (const name of ['core', 'schemas', 'providers', 'worker']) {
    const workspace = name === 'worker' ? 'apps/worker' : `packages/${name}`;
    const destination = join(output, 'vendor', name);
    await mkdir(destination, { recursive: true });
    await cp(
      join(root, workspace, 'package.json'),
      join(destination, 'package.json'),
    );
    await mkdir(join(destination, 'dist'));
    const sources = new Set(
      (await readdir(join(root, workspace, 'src'))).map((file) =>
        file.replace(/\.ts$/, ''),
      ),
    );
    for (const file of await readdir(join(root, workspace, 'dist'))) {
      if (
        sources.has(
          file.replace(/(?:\.d)?\.js(?:\.map)?$|\.d\.ts(?:\.map)?$/, ''),
        )
      )
        await cp(
          join(root, workspace, 'dist', file),
          join(destination, 'dist', file),
        );
    }
    pkg.dependencies[`@places/${name}`] = `file:vendor/${name}`;
  }
  await cp(join(root, 'apps/functions/dist'), join(output, 'dist'), {
    recursive: true,
  });
  await cp(join(root, 'LICENSE'), join(output, 'LICENSE'));
  await writeFile(
    join(output, 'package.json'),
    JSON.stringify(pkg, null, 2) + '\n',
  );
  await writeFile(
    join(output, 'RELEASE.json'),
    JSON.stringify({ commit, target }) + '\n',
  );
  // Preserve the tested dependency graph while rewriting workspace links for Cloud Build.
  const sourceLock = JSON.parse(
    await readFile(join(root, 'package-lock.json'), 'utf8'),
  );
  const workspaces = {
    'packages/core': 'vendor/core',
    'packages/schemas': 'vendor/schemas',
    'packages/providers': 'vendor/providers',
    'apps/worker': 'vendor/worker',
  };
  const packages = {
    '': {
      name: pkg.name,
      version: pkg.version,
      dependencies: pkg.dependencies,
      engines: pkg.engines,
    },
  };
  for (const [path, metadata] of Object.entries(sourceLock.packages)) {
    if (
      !path ||
      metadata.dev ||
      path === 'apps/functions' ||
      path === 'node_modules/@places/functions'
    )
      continue;
    const key = workspaces[path] ?? path;
    packages[key] = {
      ...metadata,
      ...(metadata.link && workspaces[metadata.resolved]
        ? { resolved: workspaces[metadata.resolved] }
        : {}),
    };
  }
  await writeFile(
    join(output, 'package-lock.json'),
    JSON.stringify(
      {
        name: pkg.name,
        version: pkg.version,
        lockfileVersion: 3,
        requires: true,
        packages,
      },
      null,
      2,
    ) + '\n',
  );
  // Resolve a standalone production lock; only explicit public code goes to Cloud Build.
  execFileSync(
    'npm',
    [
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
    ],
    { cwd: output, stdio: 'pipe' },
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  if (
    execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()
  )
    throw new Error('functions_packaging_requires_clean_checkout');
  const args = process.argv.slice(2);
  if (
    ![2, 4].includes(args.length) ||
    args[0] !== '--output' ||
    (args.length === 4 && args[2] !== '--target')
  )
    throw new Error('output_required');
  await packageFunctions(
    process.cwd(),
    resolve(args[1]),
    commit,
    args[3] ?? 'webhook',
  );
  console.info(`functions_packaged:${commit}`);
}
