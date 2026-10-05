import test from 'node:test';
import assert from 'node:assert/strict';
import { Firestore } from '@google-cloud/firestore';
import { FirestoreRepository } from '@places/providers';
import { initializeWorkspace } from './workspace-init.mjs';
const project = 'demo-places-tests';
const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!host || !/^(?:127\.0\.0\.1|localhost):\d+$/.test(host))
  throw new Error('local_emulator_required');
const base = `http://${host}/v1/projects/${project}/databases/(default)/documents`;
const jwt = (uid) =>
  [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
      'base64url',
    ),
    Buffer.from(
      JSON.stringify({
        sub: uid,
        user_id: uid,
        aud: project,
        iss: `https://securetoken.google.com/${project}`,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
        firebase: { sign_in_provider: 'custom' },
      }),
    ).toString('base64url'),
    '',
  ].join('.');
async function request(path, method = 'GET', uid, data) {
  const response = await fetch(`${base}/${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(uid
        ? { Authorization: `Bearer ${uid === 'owner' ? 'owner' : jwt(uid)}` }
        : {}),
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  return response.status;
}
const data = (members) => ({
  fields: {
    members: {
      arrayValue: { values: members.map((stringValue) => ({ stringValue })) },
    },
  },
});
test('real Firestore rules deny empty/nonmember/anonymous reads and all writes; member read can be enabled later', async () => {
  assert.equal(
    await request('workspaces/empty', 'PATCH', 'owner', data([])),
    200,
  );
  for (const collection of [
    'places',
    'chains',
    'discoveries',
    'telegramInteractions',
    'cityPrompts',
    'pendingIngress',
  ])
    assert.equal(
      await request(
        `workspaces/empty/${collection}/fixture`,
        'PATCH',
        'owner',
        { fields: { fixture: { booleanValue: true } } },
      ),
      200,
    );
  for (const uid of [undefined, 'fixture-member', 'fixture-outsider']) {
    assert.equal(await request('workspaces/empty', 'GET', uid), 403);
    for (const collection of [
      'places',
      'chains',
      'discoveries',
      'telegramInteractions',
      'cityPrompts',
      'pendingIngress',
    ])
      assert.equal(
        await request(`workspaces/empty/${collection}/fixture`, 'GET', uid),
        403,
      );
    assert.equal(
      await request('workspaces/empty', 'PATCH', uid, data(['fixture-member'])),
      403,
    );
  }
  assert.equal(
    await request(
      'workspaces/empty',
      'PATCH',
      'owner',
      data(['fixture-member']),
    ),
    200,
  );
  assert.equal(await request('workspaces/empty', 'GET', 'fixture-member'), 200);
  for (const collection of ['places', 'chains', 'discoveries']) {
    assert.equal(
      await request(
        `workspaces/empty/${collection}/fixture`,
        'GET',
        'fixture-member',
      ),
      200,
    );
    assert.equal(
      await request(
        `workspaces/empty/${collection}/fixture`,
        'PATCH',
        'fixture-member',
        { fields: {} },
      ),
      403,
    );
    assert.equal(
      await request(
        `workspaces/empty/${collection}/fixture`,
        'GET',
        'fixture-outsider',
      ),
      403,
    );
  }
  for (const collection of [
    'telegramInteractions',
    'cityPrompts',
    'pendingIngress',
  ])
    assert.equal(
      await request(
        `workspaces/empty/${collection}/fixture`,
        'GET',
        'fixture-member',
      ),
      403,
    );
  assert.equal(await request('_runtime/fixture', 'GET', 'fixture-member'), 403);
});
test('real local Firestore transactions initialize idempotently and serialize confirm/cancel with deterministic deduplication', async () => {
  // Demo project + explicitly local endpoint. No ADC or Firebase Auth accounts.
  const db = new Firestore({ projectId: project, host, ssl: false });
  try {
    const repository = new FirestoreRepository(db);
    await initializeWorkspace(repository, 'transaction-fixture');
    const workspace = await repository.getWorkspace('transaction-fixture');
    assert.deepEqual(
      await initializeWorkspace(repository, 'transaction-fixture'),
      workspace,
    );
    const time = '2026-01-01T00:00:00.000Z';
    const candidate = {
      canonicalName: 'Fixture Cafe',
      aliases: [],
      category: 'cafe',
      coordinates: { latitude: 10, longitude: 20, crs: 'WGS84' },
      address: { formatted: 'Fixture address' },
      resolution: 'deterministic_poi',
      providerIdentity: { provider: 'nominatim', id: 'node/999' },
      references: [
        { provider: 'nominatim', externalId: 'node/999', observedAt: time },
      ],
      confidence: 0.9,
    };
    const discovery = (id) => ({
      id,
      workspaceId: workspace.id,
      source: { provider: 'fixture', observedAt: time },
      recognition: { visibleText: [], clues: [] },
      candidates: [candidate],
      visionProvider: 'fixture',
      status: 'needs_confirmation',
      revision: 0,
      createdAt: time,
    });
    await repository.createDiscovery(discovery('race'));
    const results = await Promise.all([
      repository.finishDiscovery(workspace.id, 'race', 0, 'confirm'),
      repository.finishDiscovery(workspace.id, 'race', 0, 'cancel'),
    ]);
    assert.equal(results.filter((r) => r.changed).length, 1);
    const terminal = await repository.getDiscovery(workspace.id, 'race');
    assert.equal(!!terminal.confirmedPlaceId, terminal.status === 'confirmed');
    await repository.createDiscovery(discovery('one'));
    await repository.createDiscovery(discovery('two'));
    const confirmations = await Promise.all(
      ['one', 'two'].map((id) =>
        repository.finishDiscovery(workspace.id, id, 0, 'confirm'),
      ),
    );
    assert.equal(confirmations[0].place.id, confirmations[1].place.id);
    assert.deepEqual(confirmations[0].place.coordinates, candidate.coordinates);
  } finally {
    await db.terminate();
  }
});
