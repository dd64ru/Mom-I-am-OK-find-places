import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const commands = [
  'worker',
  'oauth',
  'models',
  'vision:smoke',
  'telegram:ids',
  'runtime:init',
];
export async function packageRelease(root, output, commit) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('invalid_release_commit');
  // Packaging requires production pruning first; do not ship a compiler/dev tree.
  const dependencies = JSON.parse(
    await readFile(join(root, 'node_modules/.package-lock.json'), 'utf8'),
  );
  if (Object.values(dependencies.packages).some((p) => p.dev && !p.link))
    throw new Error(
      'release_requires_production_dependencies:npm_prune_omit_dev',
    );
  const stage = await mkdtemp(join(tmpdir(), 'places-release-'));
  try {
    const source = JSON.parse(
      await readFile(join(root, 'package.json'), 'utf8'),
    );
    const runtime = {
      name: source.name,
      private: true,
      type: 'module',
      license: 'MIT',
      engines: source.engines,
      workspaces: source.workspaces,
      scripts: Object.fromEntries(
        commands.map((cmd) => [cmd, source.scripts[cmd]]),
      ),
    };
    if (commands.some((cmd) => typeof runtime.scripts[cmd] !== 'string'))
      throw new Error('release_command_missing');
    await writeFile(
      join(stage, 'package.json'),
      JSON.stringify(runtime, null, 2) + '\n',
    );
    await writeFile(
      join(stage, 'RELEASE.json'),
      JSON.stringify({ version: 1, mode: 'production', commit }) + '\n',
    );
    for (const file of ['LICENSE', 'package-lock.json'])
      await cp(join(root, file), join(stage, file));
    for (const workspace of [
      'packages/schemas',
      'packages/core',
      'packages/providers',
      'apps/worker',
    ]) {
      await mkdir(join(stage, workspace), { recursive: true });
      await cp(
        join(root, workspace, 'package.json'),
        join(stage, workspace, 'package.json'),
      );
      await cp(join(root, workspace, 'dist'), join(stage, workspace, 'dist'), {
        recursive: true,
      });
    }
    // Preserve relative workspace symlinks; no checkout files/credentials/artifacts are copied.
    await cp(join(root, 'node_modules'), join(stage, 'node_modules'), {
      recursive: true,
      verbatimSymlinks: true,
    });
    async function checkLinks(path) {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const item = join(path, entry.name);
        if (entry.isSymbolicLink()) {
          const target = relative(stage, await realpath(item));
          if (target.startsWith('..') || resolve(stage, target) === stage)
            throw new Error('release_external_symlink');
        } else if (entry.isDirectory()) await checkLinks(item);
      }
    }
    await checkLinks(stage);
    await mkdir(dirname(output), { recursive: true });
    execFileSync(
      'tar',
      [
        '--sort=name',
        '--mtime=@0',
        '--owner=0',
        '--group=0',
        '--numeric-owner',
        '--hard-dereference',
        '-czf',
        output,
        '-C',
        stage,
        '.',
      ],
      { stdio: 'pipe' },
    );
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--output')
    throw new Error('usage:deploy_package_output');
  const root = process.cwd();
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  if (
    execFileSync('git', ['status', '--porcelain'], {
      cwd: root,
      encoding: 'utf8',
    }).trim()
  )
    throw new Error('release_requires_clean_checkout');
  await packageRelease(root, resolve(args[1]), commit);
  console.info(`release_packaged:${commit}`);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  void main().catch(() => {
    console.error(
      'release_packaging_failed:check_clean_checkout_build_and_production_prune',
    );
    process.exitCode = 1;
  });
}
