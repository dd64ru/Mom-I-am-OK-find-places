import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const project = 'mom-im-ok-places';
const region = 'europe-west3';
export function validateCaller(value) {
  if (
    typeof value !== 'string' ||
    !/^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com|[0-9]+-compute@developer\.gserviceaccount\.com)$/.test(
      value,
    ) ||
    value.endsWith(`@${project}.iam.gserviceaccount.com`)
  )
    throw new Error('expected_app_caller_invalid');
  return value;
}
export function verifyPolicy(policy, caller, requireCaller = true) {
  if (!policy || !Array.isArray(policy.bindings ?? []))
    throw new Error('service_iam_invalid');
  const bindings = policy.bindings ?? [];
  if (
    bindings.some(
      (b) =>
        !Array.isArray(b.members) ||
        b.members.some((m) =>
          ['allUsers', 'allAuthenticatedUsers'].includes(m),
        ),
    )
  )
    throw new Error('public_service_iam_forbidden');
  if (
    requireCaller &&
    !bindings.some(
      (b) =>
        b.role === 'roles/run.invoker' &&
        !b.condition &&
        b.members.includes(`serviceAccount:${caller}`),
    )
  )
    throw new Error('expected_app_invoker_missing');
}
export function reconcileServiceIam(
  caller,
  run = (args) =>
    JSON.parse(
      execFileSync('gcloud', [...args, '--format=json'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    ),
) {
  validateCaller(caller);
  const fn = run([
    'functions',
    'describe',
    'placesService',
    '--gen2',
    '--region',
    region,
    '--project',
    project,
  ]);
  const resource = fn?.serviceConfig?.service;
  const match =
    /^projects\/([^/]+)\/locations\/europe-west3\/services\/placesservice$/.exec(
      resource ?? '',
    );
  if (!match) throw new Error('unexpected_service_resource');
  if (match[1] !== project) {
    const metadata = run(['projects', 'describe', project]);
    if (!metadata.projectNumber || match[1] !== String(metadata.projectNumber))
      throw new Error('unexpected_service_resource');
  }
  const scope = ['placesservice', '--region', region, '--project', project];
  const service = run(['run', 'services', 'describe', ...scope]);
  if (service?.metadata?.name !== 'placesservice')
    throw new Error('unexpected_run_service');
  if (
    service?.metadata?.annotations?.[
      'run.googleapis.com/invoker-iam-disabled'
    ] === 'true'
  )
    throw new Error('service_iam_checks_disabled');
  const read = () => run(['run', 'services', 'get-iam-policy', ...scope]);
  verifyPolicy(read(), caller, false);
  run([
    'run',
    'services',
    'add-iam-policy-binding',
    ...scope,
    `--member=serviceAccount:${caller}`,
    '--role=roles/run.invoker',
    '--condition=None',
    '--quiet',
  ]);
  verifyPolicy(read(), caller);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const caller = validateCaller(process.env.PLACES_EXPECTED_APP_CALLER_SA);
    if (process.argv[2] === '--validate-only' && process.argv.length === 3)
      console.info('expected_app_caller_valid');
    else if (process.argv.length === 2) {
      reconcileServiceIam(caller);
      console.info('private_service_iam_verified');
    } else throw new Error('invalid_arguments');
  } catch {
    console.error('private_service_iam_reconciliation_failed');
    process.exitCode = 1;
  }
}
