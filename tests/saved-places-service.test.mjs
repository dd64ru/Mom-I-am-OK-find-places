import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DiscoveryService,
  PlacesServiceApi,
  ServiceRequestSchema,
} from '@places/core';
import {
  FirestoreRepository,
  GooglePlacesPoi,
  canonicalPlaceId,
} from '@places/providers';
import { DiscoverySchema, FreshRecognitionSchema } from '@places/schemas';
import { MemoryDb } from './fixtures/memory-db.mjs';
import { row, token, project } from './fixtures/google-places.mjs';
const time = '2026-10-01T00:00:00.000Z';
const vision = {
  name: 'fixture',
  recognize: async () => {
    throw new Error('never');
  },
};
async function fixture() {
  const db = new MemoryDb(),
    repo = new FirestoreRepository(db);
  await repo.initWorkspace({
    id: 'shared',
    members: [],
    settings: { locale: 'ru' },
    createdAt: time,
    updatedAt: time,
  });
  let refreshes = 0;
  const poi = {
    refresh: async (identity) => {
      refreshes++;
      return {
        canonicalName: 'GOOGLE_DISPLAY_NEVER_DURABLE',
        coordinates: { ...row.location, crs: 'WGS84' },
        address: { formatted: 'PROVIDER_ADDRESS_NEVER_DURABLE' },
        providerIdentity: identity,
        references: [
          {
            provider: identity.provider,
            externalId: identity.id,
            observedAt: time,
            url:
              'https://www.google.com/maps/search/?api=1&query=x&query_place_id=' +
              identity.id,
          },
        ],
      };
    },
  };
  const service = new DiscoveryService(repo, vision, {
    poi,
    search: {
      verify: async () => {
        throw new Error('must_not_rediscover_id');
      },
    },
  });
  return {
    db,
    repo,
    api: new PlacesServiceApi('shared', repo, service, poi),
    refreshes: () => refreshes,
  };
}
test('channel-neutral ID prepare, atomic multi-confirm, canonical reuse, retry, fencing, licensing', async () => {
  const { db, api } = await fixture();
  const input = {
    action: 'prepare',
    requestId: 'one',
    identities: [
      { placeId: 'branch-a', label: 'My stop' },
      { placeId: 'branch-b', label: 'My stop' },
    ],
  };
  const review = await api.execute(input);
  assert.equal(review.status, 'needs_selection');
  assert.equal(review.candidates.length, 2);
  assert.equal((await api.execute(input)).discoveryId, review.discoveryId);
  await assert.rejects(
    api.execute({
      ...input,
      identities: [{ placeId: 'tampered', label: 'Other' }],
    }),
    /idempotency_conflict/,
  );
  await assert.rejects(
    api.execute({
      action: 'confirm',
      discoveryId: review.discoveryId,
      revision: 99,
      requestId: 'save',
      indices: [0],
    }),
    /stale_revision/,
  );
  const command = {
    action: 'confirm',
    discoveryId: review.discoveryId,
    revision: review.revision,
    requestId: 'save',
    indices: [0, 1],
  };
  const done = await api.execute(command);
  assert.equal(done.status, 'confirmed');
  assert.equal(done.newCount, 2);
  assert.equal((await api.execute(command)).status, 'confirmed');
  const second = await api.execute({ ...input, requestId: 'two' });
  const reused = await api.execute({
    ...command,
    discoveryId: second.discoveryId,
    requestId: 'reuse',
  });
  assert.equal(reused.reusedCount, 2);
  assert.equal(reused.newCount, 0);
  const places = [...db.values.entries()].filter(([p]) =>
    p.includes('/places/'),
  );
  assert.equal(places.length, 2);
  assert.ok(places.every(([, p]) => p.label === 'My stop'));
  const durable = JSON.stringify([...db.values.values()]);
  assert.ok(!durable.includes('GOOGLE_DISPLAY_NEVER_DURABLE'));
  assert.ok(!durable.includes('PROVIDER_ADDRESS_NEVER_DURABLE'));
  assert.ok(!durable.includes('latitude'));
  assert.equal(
    canonicalPlaceId({
      providerIdentity: { provider: 'google-places', id: 'branch-a' },
    }),
    places.find(([, p]) => p.providerIdentity.id === 'branch-a')[1].id,
  );
});
test('concurrent confirm/cancel and stale revisions cannot save an unreviewed selection', async () => {
  const { api, db } = await fixture();
  const r = await api.execute({
    action: 'prepare',
    requestId: 'race',
    identities: [{ placeId: 'id', label: 'Mine' }],
  });
  const results = await Promise.allSettled([
    api.execute({
      action: 'cancel',
      discoveryId: r.discoveryId,
      revision: r.revision,
      requestId: 'cancel',
    }),
    api.execute({
      action: 'confirm',
      discoveryId: r.discoveryId,
      revision: r.revision,
      requestId: 'confirm',
      indices: [0],
    }),
  ]);
  assert.ok(results.some((r) => r.status === 'fulfilled'));
  assert.ok(
    [...db.values.entries()].filter(([p]) => p.includes('/places/')).length <=
      1,
  );
});
test('strict service contract forbids client coordinates/workspace and unsafe bounds', () => {
  for (const input of [
    {
      action: 'prepare',
      requestId: 'x',
      identities: [{ placeId: 'id', label: 'Mine', coordinates: row.location }],
    },
    {
      action: 'prepare',
      requestId: 'x',
      workspaceId: 'other',
      identities: [{ placeId: 'id', label: 'Mine' }],
    },
    {
      action: 'confirm',
      requestId: 'x',
      discoveryId: 'd',
      revision: 0,
      indices: [0, 0],
    },
  ])
    assert.equal(ServiceRequestSchema.safeParse(input).success, false);
});
const scene = {
  mode: 'scene_viewpoint',
  visibleText: [],
  clues: [],
  scene: {
    cityHint: 'Shenzhen',
    countryCode: 'CN',
    landmarks: ['China Resources Headquarters'],
    context: 'waterfront',
  },
};
const clue = (name) => ({
  canonicalName: name,
  aliases: [],
  category: 'park',
  city: 'Shenzhen',
  cityAliases: [],
  countryCode: 'CN',
  confidence: 0.5,
});
const sceneRow = (id, name, city = 'Shenzhen', country = 'CN') => ({
  ...row,
  id,
  displayName: { text: name },
  types: ['park'],
  addressComponents: [
    { longText: city, types: ['locality'] },
    { shortText: country, types: ['country'] },
  ],
});
test('Shenzhen scene survives no_place_evidence, enriches once, returns two uncertain provider-backed viewpoints', async () => {
  const { repo } = await fixture();
  let searches = 0,
    queries = 0;
  const poi = new GooglePlacesPoi(
    async () => token,
    project,
    async (_url, init) => {
      if (init.method === 'POST') queries++;
      return Response.json({
        places: [
          sceneRow('park-a', 'Shenzhen Bay Park'),
          sceneRow('park-b', 'Talent Park'),
          sceneRow('landmark', 'China Resources Headquarters'),
          sceneRow('wrong-city', 'Talent Park', 'Paris'),
          sceneRow('wrong-country', 'Talent Park', 'Shenzhen', 'FR'),
        ],
      });
    },
  );
  const service = new DiscoveryService(repo, vision, {
    poi,
    search: {
      verify: async () => {
        searches++;
        return {
          status: 'verified',
          candidates: [clue('Shenzhen Bay Park'), clue('Talent Park')],
          references: [
            { provider: 'web', url: 'https://example.org', observedAt: time },
          ],
        };
      },
    },
  });
  const discovery = await repo.createDiscovery(
    DiscoverySchema.parse({
      id: 'scene',
      workspaceId: 'shared',
      source: { provider: 'telegram', observedAt: time },
      recognition: scene,
      candidates: [],
      visionProvider: 'fixture',
      status: 'needs_confirmation',
      revision: 0,
      createdAt: time,
    }),
  );
  const result = await service.resolve(discovery);
  assert.equal(result.status, 'needs_selection');
  assert.equal(searches, 1);
  assert.ok(queries <= 2);
  assert.deepEqual(result.candidates.map((c) => c.providerIdentity.id).sort(), [
    'park-a',
    'park-b',
  ]);
  assert.ok(
    result.candidates.every(
      (c) =>
        c.candidateConfidence === 'low' &&
        c.relationship === 'viewpoint_hypothesis',
    ),
  );
});
test('empty scene resolution stays unresolved; empty ordinary image still skips web', async () => {
  assert.equal(FreshRecognitionSchema.safeParse(scene).success, true);
  const { repo } = await fixture();
  let searches = 0;
  const poi = new GooglePlacesPoi(
    async () => token,
    project,
    async () => Response.json({ places: [] }),
  );
  const service = new DiscoveryService(repo, vision, {
    poi,
    search: {
      verify: async () => {
        searches++;
        return { status: 'no_evidence', candidates: [], references: [] };
      },
    },
  });
  for (const [id, recognition] of [
    ['scene-empty', scene],
    ['ordinary-empty', { visibleText: [], clues: [] }],
  ]) {
    const d = await repo.createDiscovery(
      DiscoverySchema.parse({
        id,
        workspaceId: 'shared',
        source: { provider: 'telegram', observedAt: time },
        recognition,
        candidates: [],
        visionProvider: 'fixture',
        status: 'needs_confirmation',
        revision: 0,
        createdAt: time,
      }),
    );
    assert.equal((await service.resolve(d)).status, 'unresolved');
  }
  assert.equal(searches, 1);
});
test('deterministic locality identity groups multilingual input; country/region ambiguity fails safely', async () => {
  const venue = {
    ...row,
    addressComponents: [
      { longText: 'Shanghai', types: ['locality'] },
      { shortText: 'CN', types: ['country'] },
      { longText: 'Shanghai region', types: ['administrative_area_level_1'] },
    ],
  };
  const locality = {
    ...venue,
    id: 'locality-shanghai',
    displayName: { text: 'Shanghai' },
    types: ['locality'],
  };
  let results = [locality];
  const provider = new GooglePlacesPoi(
    async () => token,
    project,
    async (_url, options) =>
      Response.json(options.method === 'GET' ? venue : { places: results }),
  );
  const identities = await Promise.all(
    ['Shanghai', 'Шанхай', '上海'].map((city) =>
      provider.resolveLocality({ provider: 'google-places', id: row.id }, city),
    ),
  );
  assert.ok(identities.every((i) => i.key === identities[0].key));
  results = [locality, { ...locality, id: 'other-locality' }];
  assert.equal(
    await provider.resolveLocality(
      { provider: 'google-places', id: row.id },
      'Shanghai',
    ),
    undefined,
  );
  results = [
    {
      ...locality,
      addressComponents: [
        { shortText: 'FR', types: ['country'] },
        { longText: 'Shanghai region', types: ['administrative_area_level_1'] },
      ],
    },
  ];
  assert.equal(
    await provider.resolveLocality(
      { provider: 'google-places', id: row.id },
      'Shanghai',
    ),
    undefined,
  );
});
test('locality backfill emits a bounded, stale-fenced plan only and cannot write', async () => {
  const { planLocalityBackfill } = await import('@places/core');
  const { db, api } = await fixture();
  const r = await api.execute({
    action: 'prepare',
    requestId: 'migration',
    identities: [{ placeId: 'venue', label: 'Mine', city: 'Шанхай' }],
  });
  await api.execute({
    action: 'confirm',
    discoveryId: r.discoveryId,
    revision: 0,
    requestId: 'save-migration',
    indices: [0],
  });
  const places = [...db.values.entries()]
    .filter(([p]) => p.includes('/places/'))
    .map(([, p]) => p);
  const before = JSON.stringify([...db.values]);
  const plan = await planLocalityBackfill(places, {
    resolveLocality: async () => ({
      key: 'google-locality:' + 'a'.repeat(64),
      source: 'google-places-locality',
    }),
  });
  assert.equal(plan.mode, 'plan-only');
  assert.equal(plan.plan.length, 1);
  assert.equal(plan.plan[0].expectedUpdatedAt, places[0].updatedAt);
  assert.equal(JSON.stringify([...db.values]), before);
});

test('same-name localities in different countries/regions keep distinct provider identity; missing region fails safe', async () => {
  const make = (country, region, id) => {
    const venue = {
      ...row,
      displayName: { text: 'Venue' },
      addressComponents: [
        { longText: 'Paris', types: ['locality'] },
        { shortText: country, types: ['country'] },
        ...(region
          ? [{ longText: region, types: ['administrative_area_level_1'] }]
          : []),
      ],
    };
    const locality = {
      ...venue,
      id,
      displayName: { text: 'Paris' },
      types: ['locality'],
    };
    return new GooglePlacesPoi(
      async () => token,
      project,
      async (_url, init) =>
        Response.json(init.method === 'GET' ? venue : { places: [locality] }),
    );
  };
  const identities = [];
  for (const [country, region, id] of [
    ['FR', 'Ile de France', 'paris-fr'],
    ['US', 'Texas', 'paris-tx'],
    ['US', 'Illinois', 'paris-il'],
  ]) {
    identities.push(
      await make(country, region, id).resolveLocality(
        { provider: 'google-places', id: row.id },
        'Paris',
      ),
    );
  }
  assert.equal(new Set(identities.map((i) => i.key)).size, 3);
  assert.equal(
    await make('US', undefined, 'ambiguous').resolveLocality(
      { provider: 'google-places', id: row.id },
      'Paris',
    ),
    undefined,
  );
});
