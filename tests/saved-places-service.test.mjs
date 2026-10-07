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
  const done = await repo.finishDiscovery(
    'shared',
    result.id,
    result.revision,
    'confirm',
    { indices: [0, 1], requestId: 'scene-labels' },
  );
  assert.deepEqual(done.places.map((p) => p.label).sort(), [
    'Shenzhen Bay Park',
    'Talent Park',
  ]);
  assert.ok(done.places.every((p) => p.labelSource === 'recognition'));
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
    async (_url, options) => {
      if (options.method === 'GET') return Response.json(venue);
      const body = JSON.parse(options.body);
      return Response.json({
        places: results.map((r) => ({
          ...r,
          displayName: {
            text:
              body.languageCode === 'ru'
                ? 'Шанхай'
                : body.languageCode === 'zh'
                  ? '上海'
                  : r.displayName.text,
          },
        })),
      });
    },
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

test('unlabeled provider IDs require human labels; retries fence labels and canonical reuse preserves original label', async () => {
  const { api, db } = await fixture();
  const r = await api.execute({
    action: 'prepare',
    requestId: 'unlabeled',
    identities: [{ placeId: 'west' }, { placeId: 'east' }],
  });
  assert.ok(
    r.candidates.every(
      (c) =>
        c.requiresLabel &&
        !c.label &&
        c.name === 'GOOGLE_DISPLAY_NEVER_DURABLE',
    ),
  );
  const command = {
    action: 'confirm',
    discoveryId: r.discoveryId,
    revision: r.revision,
    requestId: 'human',
    indices: [0, 1],
  };
  await assert.rejects(api.execute(command), /label_required/);
  assert.equal(
    [...db.values.keys()].filter((p) => p.includes('/places/')).length,
    0,
  );
  for (const label of [
    'Saved place 1',
    'Viewpoint hypothesis',
    'Place',
    'bad\nlabel',
    'x'.repeat(301),
    '\u0085bad',
  ])
    await assert.rejects(
      api.execute({
        ...command,
        labels: [
          { index: 0, label },
          { index: 1, label: 'East park' },
        ],
      }),
    );
  const labels = [
    { index: 0, label: 'West waterfront' },
    { index: 1, label: 'East park viewpoint' },
  ];
  assert.equal((await api.execute({ ...command, labels })).newCount, 2);
  assert.equal((await api.execute({ ...command, labels })).newCount, 2);
  await assert.rejects(
    api.execute({
      ...command,
      labels: [
        { index: 0, label: 'Changed west' },
        { index: 1, label: 'East park viewpoint' },
      ],
    }),
    /idempotency_conflict/,
  );
  const reused = await api.execute({
    action: 'prepare',
    requestId: 'relabel',
    identities: [
      {
        placeId: 'west',
        label: 'Independent alternate',
        category: 'park',
        city: 'Shenzhen',
      },
    ],
  });
  assert.equal(
    (
      await api.execute({
        action: 'confirm',
        requestId: 'reuse-human',
        discoveryId: reused.discoveryId,
        revision: reused.revision,
        indices: [0],
        labels: [{ index: 0, label: 'New human name' }],
      })
    ).reusedCount,
    1,
  );
  const saved = [...db.values.entries()]
    .filter(([p]) => p.includes('/places/'))
    .map(([, p]) => p);
  assert.deepEqual(saved.map((p) => p.label).sort(), [
    'East park viewpoint',
    'West waterfront',
  ]);
  assert.ok(saved.every((p) => p.labelSource === 'user'));
  assert.ok(
    !JSON.stringify([...db.values]).includes('GOOGLE_DISPLAY_NEVER_DURABLE'),
  );
});
test('supplied city and venue locality must independently resolve to the same stable locality', async () => {
  const venue = {
    ...row,
    addressComponents: [
      { longText: 'Shanghai', types: ['locality'] },
      { shortText: 'CN', types: ['country'] },
      { longText: 'Shanghai region', types: ['administrative_area_level_1'] },
    ],
  };
  const locality = (id, name, country = 'CN') => ({
    ...venue,
    id,
    displayName: { text: name },
    types: ['locality'],
    addressComponents: [
      { longText: name, types: ['locality'] },
      { shortText: country, types: ['country'] },
      { longText: 'Shanghai region', types: ['administrative_area_level_1'] },
    ],
  });
  for (const kind of [
    'wrong-city',
    'wrong-country',
    'ambiguous',
    'missing',
    'ranking-does-not-prove-input',
    'same-name-other-region',
  ]) {
    let posts = 0;
    const provider = new GooglePlacesPoi(
      async () => token,
      project,
      async (_url, init) => {
        if (init.method === 'GET')
          return Response.json(
            kind === 'missing' ? { ...venue, addressComponents: [] } : venue,
          );
        posts++;
        const input = JSON.parse(init.body).textQuery.split(', ')[0];
        const places =
          posts === 2
            ? [locality('shanghai', 'Shanghai')]
            : kind === 'wrong-country'
              ? [locality('shanghai-us', 'Shanghai', 'US')]
              : kind === 'wrong-city'
                ? [locality('other-city', 'Wrong city')]
                : kind === 'same-name-other-region'
                  ? [locality('other-region', 'Shanghai')]
                  : kind === 'ambiguous'
                    ? [
                        locality('shanghai', 'Shanghai'),
                        locality('other', 'Shanghai'),
                      ]
                    : [locality('shanghai', 'Shanghai')];
        return Response.json({ places });
      },
    );
    assert.equal(
      await provider.resolveLocality(
        { provider: 'google-places', id: row.id },
        kind === 'wrong-city' || kind === 'ranking-does-not-prove-input'
          ? 'Wrong city'
          : 'Shanghai',
      ),
      undefined,
      kind,
    );
    assert.ok(posts <= 2);
  }
});
test('a new locality proof cannot be attached to a reused Place with a different existing display city', async () => {
  const { fillMissingMapMetadata } = await import('@places/schemas');
  const merged = fillMissingMapMetadata(
    { city: { value: 'Wrong city', source: 'user' } },
    {
      city: { value: 'Shanghai', source: 'recognition' },
      locality: {
        key: 'google-locality:' + 'a'.repeat(64),
        source: 'google-places-locality',
      },
      category: { value: 'park', source: 'recognition' },
    },
  );
  assert.equal(merged.city.value, 'Wrong city');
  assert.equal(merged.locality, undefined);
});

test('unbound Telegram viewpoint candidates cannot fall back to generic durable labels', async () => {
  const { api, repo, db } = await fixture();
  const r = await api.execute({
    action: 'prepare',
    requestId: 'viewpoint-unbound',
    identities: [{ placeId: 'west-view' }, { placeId: 'east-view' }],
  });
  const stored = await repo.getDiscovery('shared', r.discoveryId);
  const d = await repo.createDiscovery(
    DiscoverySchema.parse({
      ...stored,
      id: 'telegram-unbound',
      source: { provider: 'telegram', observedAt: time },
      recognition: scene,
      selectedCandidateIndices: [0, 1],
    }),
  );
  await assert.rejects(
    repo.finishDiscovery('shared', d.id, d.revision, 'confirm'),
    /label_required/,
  );
  assert.equal(
    [...db.values.keys()].filter((p) => p.includes('/places/')).length,
    0,
  );
  const result = await repo.finishDiscovery(
    'shared',
    d.id,
    d.revision,
    'confirm',
    {
      indices: [0, 1],
      requestId: 'name-viewpoints',
      labels: [
        { index: 0, label: 'West view over the bay' },
        { index: 1, label: 'East park promenade' },
      ],
    },
  );
  assert.deepEqual(result.places.map((p) => p.label).sort(), [
    'East park promenade',
    'West view over the bay',
  ]);
  assert.ok(result.places.every((p) => p.labelSource === 'user'));
});

for (const labelSource of ['user', 'recognition'])
  test(`legacy unlabeled canonical reuse atomically fills authorized ${labelSource} label and becomes projectable`, async () => {
    const { ProjectionService } = await import('@places/core');
    const { db, repo, api } = await fixture();
    const providerIdentity = {
      provider: 'google-places',
      id: 'legacy-' + labelSource,
    };
    const reference = {
      provider: 'google-places',
      externalId: providerIdentity.id,
      observedAt: time,
      url: 'https://www.google.com/maps/',
    };
    const legacy = {
      id: canonicalPlaceId({ providerIdentity }),
      workspaceId: 'shared',
      providerIdentity,
      source: reference,
      evidence: [reference],
      tags: ['keep-tag'],
      status: 'confirmed',
      mapMetadata: {
        city: { value: 'Existing city', source: 'user' },
        ...(labelSource === 'recognition'
          ? { category: { value: 'Original category', source: 'user' } }
          : {}),
      },
      createdAt: time,
      updatedAt: time,
    };
    await repo.savePlace(legacy);
    const projection = new ProjectionService({
      refresh: async (identity) => ({
        canonicalName: 'GOOGLE_DISPLAY_NEVER_DURABLE',
        coordinates: { ...row.location, crs: 'WGS84' },
        address: { formatted: 'PROVIDER_ADDRESS_NEVER_DURABLE' },
        providerIdentity: identity,
        references: [{ ...reference, externalId: identity.id }],
      }),
    });
    assert.equal((await projection.project([legacy])).counts.missingLabels, 1);
    const label =
      labelSource === 'user'
        ? 'My waterfront stop'
        : 'Independent waterfront park';
    const r = await api.execute({
      action: 'prepare',
      requestId: 'enrich-' + labelSource,
      identities: [
        {
          placeId: providerIdentity.id,
          category: 'park',
          city: 'Shenzhen',
          label:
            labelSource === 'recognition'
              ? label
              : 'Independently recognized waterfront park',
        },
      ],
    });
    const updates = [],
      transact = db.runTransaction.bind(db);
    db.runTransaction = (fn) =>
      transact((tx) =>
        fn({
          ...tx,
          update: (ref, patch) => {
            if (ref.path.includes('/places/'))
              updates.push(structuredClone(patch));
            tx.update(ref, patch);
          },
        }),
      );
    const command = {
      action: 'confirm',
      discoveryId: r.discoveryId,
      revision: r.revision,
      requestId: 'fill-' + labelSource,
      indices: [0],
      ...(labelSource === 'user' ? { labels: [{ index: 0, label }] } : {}),
    };
    const done = await api.execute(command);
    assert.equal(done.reusedCount, 1);
    assert.equal(done.newCount, 0);
    const saved = await repo.getPlace('shared', legacy.id);
    assert.equal(saved.label, label);
    assert.equal(saved.labelSource, labelSource);
    assert.equal(
      [...db.values.keys()].filter((p) => p.includes('/places/')).length,
      1,
    );
    const {
      label: _label,
      labelSource: _source,
      mapMetadata,
      updatedAt,
      ...unchanged
    } = saved;
    const {
      mapMetadata: oldMetadata,
      updatedAt: oldTime,
      ...oldFields
    } = legacy;
    assert.deepEqual(unchanged, oldFields);
    assert.deepEqual(mapMetadata.city, oldMetadata.city);
    assert.equal(
      mapMetadata.category.value,
      labelSource === 'recognition' ? 'Original category' : 'park',
    );
    assert.equal(updates.length, 1);
    assert.deepEqual(
      Object.keys(updates[0]).sort(),
      labelSource === 'recognition'
        ? ['label', 'labelSource', 'updatedAt']
        : ['label', 'labelSource', 'mapMetadata', 'updatedAt'],
    );
    const projected = await projection.project([saved]);
    assert.equal(projected.counts.missingLabels, 0);
    assert.equal(projected.counts.placesProjected, 1);
    assert.equal(projected.places[0].label, label);
    assert.ok(
      !JSON.stringify([...db.values]).includes('GOOGLE_DISPLAY_NEVER_DURABLE'),
    );
    assert.ok(
      !JSON.stringify([...db.values]).includes(
        'PROVIDER_ADDRESS_NEVER_DURABLE',
      ),
    );
    assert.equal((await api.execute(command)).reusedCount, 1);
    assert.equal(updates.length, 1);
  });

test('single bound Google identity re-review uses application label without refresh; confirm still refreshes', async () => {
  const f = await fixture();
  const prepared = await f.api.execute({
    action: 'prepare',
    requestId: 'cheap-review',
    identities: [{ placeId: 'known-poi', label: 'Independent landmark' }],
  });
  const count = f.refreshes();
  for (let i = 0; i < 3; i++) {
    const review = await f.api.execute({
      action: 'review',
      discoveryId: prepared.discoveryId,
    });
    assert.equal(review.candidates[0].name, 'Independent landmark');
    assert.ok(
      review.candidates[0].googleMapsUrl.includes('query_place_id=known-poi'),
    );
    assert.equal(f.refreshes(), count);
  }
  await f.api.execute({
    action: 'confirm',
    discoveryId: prepared.discoveryId,
    revision: prepared.revision,
    requestId: 'confirm-cheap',
    indices: [0],
  });
  assert.ok(f.refreshes() > count);
});
test('unlabeled candidate retains provider review refresh', async () => {
  const f = await fixture();
  const p = await f.api.execute({
    action: 'prepare',
    requestId: 'unlabeled-refresh',
    identities: [{ placeId: 'unknown-label' }],
  });
  const before = f.refreshes();
  await f.api.execute({ action: 'review', discoveryId: p.discoveryId });
  assert.ok(f.refreshes() > before);
});
