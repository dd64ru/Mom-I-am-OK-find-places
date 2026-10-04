import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  stat,
  symlink,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { packageRelease } from '../scripts/package-release.mjs';
const root = resolve('.');
const commit = 'a'.repeat(40);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function temporary(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'infra-places-test-'));
  try {
    await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
test('production bundle is reproducible, prebuilt, allowlisted and safely extractable', async () =>
  temporary(async (temp) => {
    const source = join(temp, 'source');
    await mkdir(source);
    const scripts = Object.fromEntries(
      [
        'worker',
        'oauth',
        'models',
        'vision:smoke',
        'telegram:ids',
        'runtime:init',
      ].map((key) => [key, 'node apps/worker/dist/main.js']),
    );
    await writeFile(
      join(source, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        workspaces: ['packages/*', 'apps/worker'],
        scripts: { ...scripts, preoauth: 'npm run build' },
        devDependencies: { typescript: 'fixture' },
      }),
    );
    await writeFile(join(source, 'package-lock.json'), '{}');
    await writeFile(join(source, 'LICENSE'), 'MIT fixture');
    await writeFile(join(source, '.env'), 'PRIVATE_FIXTURE_EXCLUDED');
    await mkdir(join(source, '.credentials'));
    await writeFile(
      join(source, '.credentials/owner.json'),
      'PRIVATE_FIXTURE_EXCLUDED',
    );
    for (const workspace of [
      'apps/worker',
      'packages/core',
      'packages/schemas',
      'packages/providers',
    ]) {
      await mkdir(join(source, workspace, 'dist'), { recursive: true });
      await writeFile(join(source, workspace, 'package.json'), '{}');
      await writeFile(join(source, workspace, 'dist/main.js'), 'export {};');
    }
    await writeFile(
      join(source, 'apps/worker/dist/runtime-init-cli.js'),
      'export {};',
    );
    await mkdir(join(source, 'node_modules/@places'), { recursive: true });
    await writeFile(
      join(source, 'node_modules/.package-lock.json'),
      '{"packages":{}}',
    );
    await symlink(
      '../../packages/core',
      join(source, 'node_modules/@places/core'),
    );
    const first = join(temp, 'first.tgz'),
      second = join(temp, 'second.tgz');
    await packageRelease(source, first, commit);
    await packageRelease(source, second, commit);
    assert.deepEqual(await readFile(first), await readFile(second));
    const entries = execFileSync('tar', ['-tzf', first], { encoding: 'utf8' });
    assert.doesNotMatch(
      entries,
      /\.env|\.credentials|typescript|\/src\/|\.git\//,
    );
    const destination = join(temp, 'extracted');
    await mkdir(destination);
    execFileSync('python3', [
      join(root, 'infra/validate-release.py'),
      first,
      destination,
      commit,
      digest(await readFile(first)),
    ]);
    const runtime = JSON.parse(
      await readFile(join(destination, 'package.json')),
    );
    assert.deepEqual(runtime.scripts, scripts);
    assert.equal(runtime.devDependencies, undefined);
    assert.deepEqual(
      JSON.parse(await readFile(join(destination, 'RELEASE.json'))),
      { version: 1, mode: 'production', commit },
    );
    // Run the actual installer against an isolated filesystem and fake systemd.
    const vm = join(temp, 'vm');
    for (const path of [
      'run',
      'tmp',
      'opt/places-releases',
      'usr/local/lib/places',
      'etc/systemd/system',
      'var/lib/places',
      'bin',
    ])
      await mkdir(join(vm, path), { recursive: true });
    await writeFile(
      join(vm, 'usr/local/lib/places/validate-release.py'),
      await readFile('infra/validate-release.py'),
    );
    await writeFile(
      join(vm, 'etc/systemd/system/places-worker.service'),
      'fixture',
    );
    const privateState = join(vm, 'var/lib/places/owner.json');
    await writeFile(privateState, 'PRIVATE_STATE_PRESERVED');
    const installer = (await readFile('infra/install-release.sh', 'utf8'))
      .replace('$EUID == 0', '1 == 1')
      .replaceAll('/opt/', `${vm}/opt/`)
      .replaceAll('/var/lib/', `${vm}/var/lib/`)
      .replaceAll('/usr/local/', `${vm}/usr/local/`)
      .replaceAll('/etc/systemd/', `${vm}/etc/systemd/`)
      .replaceAll('/run/', `${vm}/run/`)
      .replaceAll('/tmp/places-', `${vm}/tmp/places-`);
    await writeFile(join(vm, 'installer.sh'), installer);
    await writeFile(join(vm, 'bin/sleep'), '#!/usr/bin/env bash\nexit 0\n', {
      mode: 0o755,
    });
    await writeFile(
      join(vm, 'bin/systemctl'),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$MOCK_VM/calls"
case "$1" in
 is-active) test -f "$MOCK_VM/active";;
 stop) rm -f "$MOCK_VM/active";;
 start) [[ $(readlink "$MOCK_VM/opt/places") != */${'b'.repeat(40)} ]] || exit 1; touch "$MOCK_VM/active";;
 *) exit 1;;
esac
`,
      { mode: 0o755 },
    );
    const env = {
      ...process.env,
      PATH: `${vm}/bin:${process.env.PATH}`,
      MOCK_VM: vm,
    };
    const install = async (bundle, sha) => {
      const bytes = await readFile(bundle);
      await writeFile(join(vm, `tmp/places-${sha}.tgz`), bytes);
      return spawnSync('bash', [join(vm, 'installer.sh'), sha, digest(bytes)], {
        env,
        encoding: 'utf8',
      });
    };
    const initial = await install(first, commit);
    assert.equal(initial.status, 0, initial.stderr);
    assert.doesNotMatch(
      await readFile(join(vm, 'calls'), 'utf8'),
      /start|stop/,
    );
    const next = 'b'.repeat(40);
    await packageRelease(source, second, next);
    await writeFile(join(vm, 'active'), 'fixture');
    const failed = await install(second, next);
    assert.equal(failed.status, 1);
    assert.match(
      failed.stderr,
      /release_restart_failed_previous_code_restored/,
    );
    assert.equal(
      execFileSync('readlink', [join(vm, 'opt/places')], {
        encoding: 'utf8',
      }).trim(),
      join(vm, 'opt/places-releases', commit),
    );
    assert.equal(
      await readFile(privateState, 'utf8'),
      'PRIVATE_STATE_PRESERVED',
    );
    assert.ok(await stat(join(vm, 'active')));
    await writeFile(
      join(source, 'node_modules/.package-lock.json'),
      '{"packages":{"compiler":{"dev":true}}}',
    );
    await assert.rejects(
      packageRelease(source, second, commit),
      /production_dependencies/,
    );
  }));
test('release validator rejects traversal, escaping links and wrong digests with fixed diagnostics', async () =>
  temporary(async (temp) => {
    const sentinel = join(temp, 'owner.json');
    await writeFile(sentinel, 'PRIVATE_FIXTURE_UNCHANGED');
    for (const kind of ['traversal', 'link', 'digest']) {
      const archive = join(temp, `${kind}.tgz`),
        destination = join(temp, kind);
      await mkdir(destination);
      execFileSync('python3', [
        '-c',
        `import tarfile,sys,io
with tarfile.open(sys.argv[1],'w:gz') as t:
 m=tarfile.TarInfo('../owner.json' if sys.argv[2]=='traversal' else 'node_modules/escape')
 if sys.argv[2]=='link':
  m.type=tarfile.SYMTYPE; m.linkname='../../owner.json'; t.addfile(m)
 else:
  m.size=4; t.addfile(m,io.BytesIO(b'code'))`,
        archive,
        kind,
      ]);
      const result = spawnSync(
        'python3',
        [
          join(root, 'infra/validate-release.py'),
          archive,
          destination,
          commit,
          kind === 'digest' ? '0'.repeat(64) : digest(await readFile(archive)),
        ],
        { encoding: 'utf8' },
      );
      assert.equal(result.status, 1);
      assert.equal(result.stderr.trim(), 'release_validation_failed');
      assert.equal(result.stdout, '');
      assert.equal(
        await readFile(sentinel, 'utf8'),
        'PRIVATE_FIXTURE_UNCHANGED',
      );
    }
  }));
test('runtime:init creates only a stable private host identity and leaves profiles untouched', async () =>
  temporary(async (directory) => {
    const profile = join(directory, 'owner.json');
    await writeFile(profile, 'INVALID_PRIVATE_FIXTURE_MUST_NOT_BE_PARSED');
    const env = {
      ...process.env,
      OPENAI_SESSION_DIR: directory,
      OPENAI_PROFILE: 'owner',
    };
    const run = () =>
      execFileSync(
        process.execPath,
        [join(root, 'apps/worker/dist/runtime-init-cli.js')],
        { env, encoding: 'utf8' },
      );
    const result = JSON.parse(run());
    assert.equal(result.initialized, true);
    assert.equal(result.permissions, '700');
    const host = await readFile(join(directory, 'host.json'), 'utf8');
    assert.match(JSON.parse(host).id, /^urn:uuid:/);
    assert.equal(
      (await stat(join(directory, 'host.json'))).mode & 0o777,
      0o600,
    );
    assert.equal(
      await readFile(profile, 'utf8'),
      'INVALID_PRIVATE_FIXTURE_MUST_NOT_BE_PARSED',
    );
    assert.doesNotMatch(run(), /INVALID_PRIVATE/);
    assert.equal(await readFile(join(directory, 'host.json'), 'utf8'), host);
    await writeFile(join(directory, 'owner.lock'), 'fixture');
    const busy = spawnSync(
      process.execPath,
      [join(root, 'apps/worker/dist/runtime-init-cli.js')],
      { env, encoding: 'utf8' },
    );
    assert.equal(busy.status, 1);
    assert.match(
      busy.stderr,
      /^runtime_init_failed:check_directory_ownership_and_session_lock/,
    );
  }));
test('bootstrap plan uses metadata reads only and leaves region choice explicit', async () =>
  temporary(async (directory) => {
    const log = join(directory, 'calls');
    const mock = join(directory, 'gcloud');
    await writeFile(
      mock,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$MOCK_LOG"
case "$*" in
 *'projects describe'*) echo '{"projectNumber":"123456789"}';;
 *'firestore databases describe'*) echo eur3;;
 *'secrets describe'*) echo '{"name":"public-secret-metadata"}';;
 *) echo forbidden_mutation >&2; exit 1;;
esac
`,
      { mode: 0o755 },
    );
    const output = execFileSync('bash', ['infra/bootstrap-gcp.sh', '--plan'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        MOCK_LOG: log,
        REGION: '',
        ZONE: '',
      },
    });
    assert.match(output, /FIRESTORE_LOCATION=eur3/);
    assert.match(output, /CHOOSE_AFTER_LOCATION_REVIEW/);
    const calls = await readFile(log, 'utf8');
    assert.equal(calls.trim().split('\n').length, 4);
    assert.doesNotMatch(calls, /access|create|add-iam|enable|versions/);
    assert.match(
      execFileSync('bash', ['infra/bootstrap-gcp.sh', '--validate'], {
        encoding: 'utf8',
      }),
      /validation_ok/,
    );
  }));
test('source diagnostic commands prebuild while systemd starts compiled code only', async () => {
  const pkg = JSON.parse(await readFile('package.json'));
  for (const command of [
    'oauth',
    'models',
    'vision:smoke',
    'telegram:ids',
    'runtime:init',
  ])
    assert.equal(pkg.scripts[`pre${command}`], 'npm run build');
  const unit = await readFile('infra/places-worker.service', 'utf8');
  assert.match(
    unit,
    /ExecStart=\/usr\/local\/bin\/node \/opt\/places\/apps\/worker\/dist\/main.js/,
  );
  assert.doesNotMatch(unit, /ExecStart=.*(npm|tsc)/);
});
