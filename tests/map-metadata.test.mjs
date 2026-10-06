import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ProjectionService,
  geojson,
  planPlaceLabels,
  planPlaceMapMetadata,
  serializeProjection,
} from '@places/core';
import {
  MapMetadataSchema,
  PlaceSchema,
  ProjectedPlaceSchema,
  mapMetadataFor,
  recognitionCity,
  RECOGNITION_LOCALITY_MIN_CONFIDENCE,
} from '@places/schemas';
import { backfillPlaceMapMetadata } from '../scripts/backfill-place-map-metadata.mjs';
import { projectionEtag } from '../apps/functions/dist/feed.js';

const time = '2026-01-01T00:00:00.000Z';
const clone = structuredClone;
const ref = (id) => ({
  provider: 'google-places',
  externalId: id,
  url: 'https://example.org/PROVIDER_LINK',
  observedAt: time,
});
const googlePlace = (id, gid, extra = {}) => ({
  id,
  workspaceId: 'fixture',
  providerIdentity: { provider: 'google-places', id: gid },
  source: ref(gid),
  evidence: [ref(gid)],
  status: 'confirmed',
  tags: [],
  createdAt: time,
  updatedAt: time,
  ...extra,
});
const google = googlePlace('google-place', 'gid-exact', {
  label: 'gaga',
  labelSource: 'recognition',
});
const related = googlePlace('google-related', 'gid-related', {
  label: 'gaga',
  labelSource: 'user',
});
const clue = (name, extra = {}) => ({
  name,
  aliases: [],
  category: 'restaurant',
  confidence: 0.9,
  ...extra,
});
const discovery = (id, extra = {}) => ({
  id,
  workspaceId: 'fixture',
  source: { provider: 'telegram', observedAt: time },
  recognition: { visibleText: [], clues: [clue('gaga')] },
  candidates: [
    {
      resolution: 'deterministic_poi',
      providerIdentity: google.providerIdentity,
      references: [ref('gid-exact')],
    },
  ],
  visionProvider: 'fixture-vision',
  status: 'confirmed',
  revision: 2,
  confirmedPlaceId: google.id,
  createdAt: time,
  updatedAt: time,
  ...extra,
});
const osm = {
  id: 'osm-place',
  workspaceId: 'fixture',
  canonicalName: 'Independent OSM name',
  aliases: [],
  category: 'park',
  coordinates: { latitude: 31.2, longitude: 121.4, crs: 'WGS84' },
  address: { formatted: '1 OSM Street, Shanghai', city: 'Shanghai' },
  source: { provider: 'nominatim', externalId: 'node:1', observedAt: time },
  evidence: [{ provider: 'nominatim', externalId: 'node:1', observedAt: time }],
  confidence: 0.9,
  status: 'confirmed',
  tags: [],
  createdAt: time,
  updatedAt: time,
};
const view = {
  canonicalName: 'PROHIBITED_DISPLAY',
  coordinates: { latitude: 31.23, longitude: 121.47, crs: 'WGS84' },
  address: {
    formatted: 'PROHIBITED_ADDRESS',
    city: 'PROHIBITED_CITY',
    district: 'PROHIBITED_DISTRICT',
  },
  category: 'PROHIBITED_CATEGORY',
  types: ['PROHIBITED_TYPES'],
  attributions: [{ provider: 'PROHIBITED_CREDIT' }],
};
const hydrator = {
  refresh: async (identity) => ({ ...clone(view), providerIdentity: identity }),
};

test('legacy Google Place without mapMetadata parses; mapMetadata is strict, bounded and provenance-tagged', () => {
  assert.deepEqual(PlaceSchema.parse(google), google);
  const withMetadata = {
    ...google,
    mapMetadata: {
      city: { value: 'Shanghai', source: 'user' },
      category: { value: 'restaurant', source: 'recognition' },
    },
  };
  assert.deepEqual(PlaceSchema.parse(withMetadata), withMetadata);
  for (const bad of [
    { city: { value: 'Shanghai', source: 'google-places' } },
    { city: { value: 'Shanghai' } },
    { category: { value: 'cafe', source: 'recognition', types: ['cafe'] } },
    { city: { value: 'x'.repeat(201), source: 'user' } },
    { city: { value: 'line\nbreak', source: 'user' } },
    { formattedAddress: 'PROHIBITED' },
    {},
  ])
    assert.equal(
      PlaceSchema.safeParse({ ...google, mapMetadata: bad }).success,
      false,
      JSON.stringify(bad),
    );
  // OSM keeps its own independently licensed address/category; no mapMetadata there.
  assert.equal(
    PlaceSchema.safeParse({
      ...osm,
      mapMetadata: { city: { value: 'x', source: 'user' } },
    }).success,
    false,
  );
});

test('a Recognition city is persisted only when deterministic and unambiguous', () => {
  const recognition = (clues, mode) => ({
    visibleText: [],
    clues,
    ...(mode ? { mode } : {}),
  });
  assert.equal(RECOGNITION_LOCALITY_MIN_CONFIDENCE, 0.85);
  // Confident single clue: its own cityHint, as written, source recognition.
  assert.deepEqual(
    mapMetadataFor(
      { recognition: recognition([clue('gaga', { cityHint: '  Shanghai ' })]) },
      {},
    ).city,
    { value: 'Shanghai', source: 'recognition' },
  );
  // Below the locality threshold selectLocality trusts: no city.
  assert.equal(
    recognitionCity(
      recognition([
        clue('Happy Harbour', {
          cityHint: "Shenzhen, Bao'an",
          confidence: 0.65,
        }),
      ]),
    ),
    undefined,
  );
  // A list of alternatives is not one locality.
  for (const hint of [
    'Shanghai or Hangzhou',
    'Shanghai / Suzhou',
    'Шанхай или Ханчжоу',
    '上海或杭州',
    'A; B',
  ]) {
    assert.equal(
      recognitionCity(recognition([clue('x', { cityHint: hint })])),
      undefined,
      hint,
    );
  }
  // Single venue: other confident readings of the same venue must agree (case/space-insensitive).
  const agreeing = recognition([
    clue('a', { cityHint: 'Shanghai' }),
    clue('b', { cityHint: ' shanghai ' }),
    clue('c'),
  ]);
  assert.equal(recognitionCity(agreeing, 1), 'shanghai');
  const conflicting = recognition([
    clue('a', { cityHint: 'Shanghai' }),
    clue('b', { cityHint: 'Hangzhou' }),
  ]);
  assert.equal(recognitionCity(conflicting, 0), undefined);
  assert.equal(
    mapMetadataFor({ recognition: conflicting }, { recognitionClueIndex: 0 })
      .city,
    undefined,
  );
  // A low-confidence dissent does not make it ambiguous.
  const weakDissent = recognition([
    clue('a', { cityHint: 'Shanghai' }),
    clue('b', { cityHint: 'Hangzhou', confidence: 0.5 }),
  ]);
  assert.equal(recognitionCity(weakDissent, 0), 'Shanghai');
  // Recommendation list: different venues, each confident clue's own hint is its own city.
  const list = recognition(
    [
      clue('a', {
        cityHint: 'Shanghai',
        recommendationEvidence: 'numbered_list',
      }),
      clue('b', {
        cityHint: 'Hangzhou',
        recommendationEvidence: 'numbered_list',
      }),
    ],
    'recommendation_list',
  );
  assert.equal(recognitionCity(list, 0), 'Shanghai');
  assert.equal(recognitionCity(list, 1), 'Hangzhou');
  // Unbound among several clues: not deterministic.
  assert.equal(recognitionCity(list), undefined);
  // The explicit user city wins over a Recognition city when both exist.
  assert.deepEqual(
    mapMetadataFor(
      {
        recognition: recognition([clue('gaga', { cityHint: 'Shanghai' })]),
        cityOverride: 'Hangzhou',
      },
      {},
    ).city,
    { value: 'Hangzhou', source: 'user' },
  );
  // A Google candidate address city is never read, even if a caller passed one.
  const metadata = mapMetadataFor(
    { recognition: recognition([clue('gaga', { confidence: 0.9 })]) },
    {
      recognitionClueIndex: 0,
      address: { city: 'Google City' },
      city: 'Google City',
      formattedAddress: '1 Google Road, Google City',
    },
  );
  assert.equal(metadata.city, undefined);
  assert.ok(!JSON.stringify(metadata).includes('Google'));
});

test('mapMetadataFor derives city only from the user override or the bound clue, category only from Recognition', () => {
  const single = discovery('d').recognition;
  assert.deepEqual(mapMetadataFor({ recognition: single }, {}), {
    category: { value: 'restaurant', source: 'recognition' },
  });
  assert.deepEqual(
    mapMetadataFor({ recognition: single, cityOverride: ' Шанхай ' }, {}),
    {
      city: { value: 'Шанхай', source: 'user' },
      category: { value: 'restaurant', source: 'recognition' },
    },
  );
  const hinted = {
    visibleText: [],
    clues: [clue('gaga', { cityHint: 'Shanghai', category: 'cafe' })],
  };
  assert.deepEqual(mapMetadataFor({ recognition: hinted }, {}), {
    city: { value: 'Shanghai', source: 'recognition' },
    category: { value: 'cafe', source: 'recognition' },
  });
  // The user override beats the clue's own cityHint.
  assert.equal(
    mapMetadataFor({ recognition: hinted, cityOverride: 'Hangzhou' }, {}).city
      .source,
    'user',
  );
  // A related branch keeps the user city and the brand category, never the photographed
  // venue's own cityHint.
  assert.deepEqual(
    mapMetadataFor({ recognition: hinted }, { relationship: 'related_branch' }),
    { category: { value: 'cafe', source: 'recognition' } },
  );
  // Multiple unbound clues are ambiguous: no category, no clue city.
  const multi = {
    visibleText: [],
    clues: [
      clue('a', { cityHint: 'Shanghai' }),
      clue('b', { category: 'bar' }),
    ],
  };
  assert.equal(mapMetadataFor({ recognition: multi }, {}), undefined);
  assert.deepEqual(
    mapMetadataFor({ recognition: multi }, { recognitionClueIndex: 1 }),
    { category: { value: 'bar', source: 'recognition' } },
  );
  assert.equal(
    mapMetadataFor({ recognition: multi }, { recognitionClueIndex: 9 }),
    undefined,
  );
  // Empty/oversized independent values are omitted rather than truncated.
  assert.equal(
    mapMetadataFor(
      {
        recognition: {
          visibleText: [],
          clues: [clue('x', { category: ' ', cityHint: 'y'.repeat(300) })],
        },
      },
      {},
    ),
    undefined,
  );
});

test('metadata backfill plan derives missing fields from confirmed associations only and never overwrites', () => {
  const d = discovery('d1', { cityOverride: 'Shanghai' });
  const plan = planPlaceMapMetadata([google], [d]);
  assert.deepEqual(plan.updates, [
    {
      placeId: google.id,
      add: {
        city: { value: 'Shanghai', source: 'user' },
        category: { value: 'restaurant', source: 'recognition' },
      },
      discoveryIds: ['d1'],
    },
  ]);
  // Existing values (any source) are preserved; only the missing field is planned.
  const present = {
    ...google,
    mapMetadata: { city: { value: 'Mine', source: 'recognition' } },
  };
  const partial = planPlaceMapMetadata([present], [d]);
  assert.deepEqual(partial.updates[0].add, {
    category: { value: 'restaurant', source: 'recognition' },
  });
  assert.equal(partial.counts.cityPresent, 1);
  // Unassociated, cancelled, other-workspace and OSM Places get nothing.
  for (const other of [
    { ...d, confirmedPlaceId: 'other' },
    { ...d, status: 'cancelled', confirmedPlaceId: undefined },
    { ...d, workspaceId: 'other-workspace' },
  ])
    assert.equal(planPlaceMapMetadata([google], [other]).updates.length, 0);
  assert.equal(planPlaceMapMetadata([osm], [d]).counts.googlePlaces, 0);
});

test('metadata backfill skips conflicts, prefers the user source and lets related branches inherit only brand category and user city', () => {
  const a = discovery('a', { cityOverride: 'Shanghai' });
  const b = discovery('b', { cityOverride: 'Beijing' });
  const conflict = planPlaceMapMetadata([google], [a, b]);
  assert.equal(conflict.counts.cityConflict, 1);
  assert.deepEqual(conflict.updates[0].add, {
    category: { value: 'restaurant', source: 'recognition' },
  });
  // A user city outranks a different clue cityHint from another confirmation.
  const hinted = discovery('h', {
    recognition: {
      visibleText: [],
      clues: [clue('gaga', { cityHint: 'Pudong' })],
    },
  });
  assert.deepEqual(
    planPlaceMapMetadata([google], [a, hinted]).updates[0].add.city,
    { value: 'Shanghai', source: 'user' },
  );
  // Multi-confirmation: the related branch is bound by identity.
  const multi = discovery('m', {
    recognition: {
      visibleText: [],
      clues: [clue('gaga', { cityHint: 'Jing an', category: 'noodles' })],
    },
    candidates: [
      {
        resolution: 'deterministic_poi',
        providerIdentity: google.providerIdentity,
        references: [ref('gid-exact')],
        recognitionClueIndex: 0,
        relationship: 'likely_exact',
      },
      {
        resolution: 'deterministic_poi',
        providerIdentity: related.providerIdentity,
        references: [ref('gid-related')],
        recognitionClueIndex: 0,
        relationship: 'related_branch',
      },
    ],
    confirmedPlaceId: google.id,
    confirmedPlaceIds: [google.id, related.id],
  });
  const plan = planPlaceMapMetadata([google, related], [multi]);
  const byPlace = Object.fromEntries(
    plan.updates.map((u) => [u.placeId, u.add]),
  );
  assert.deepEqual(byPlace[google.id], {
    city: { value: 'Jing an', source: 'recognition' },
    category: { value: 'noodles', source: 'recognition' },
  });
  assert.deepEqual(byPlace[related.id], {
    category: { value: 'noodles', source: 'recognition' },
  });
  // The related branch never inherits the photographed venue's label either.
  assert.equal(
    planPlaceLabels(
      [{ ...related, label: undefined, labelSource: undefined }],
      [multi],
    ).counts.unresolved,
    1,
  );
  // Duplicate entries for one identity cannot bind a clue deterministically.
  const duplicate = {
    ...multi,
    candidates: [multi.candidates[0], multi.candidates[0]],
    confirmedPlaceIds: [google.id],
  };
  assert.equal(planPlaceMapMetadata([google], [duplicate]).updates.length, 0);
});

function backfillDb(places, discoveries) {
  const values = new Map([
    ...places.map((p) => [`workspaces/fixture/places/${p.id}`, clone(p)]),
    ...discoveries.map((d) => [
      `workspaces/fixture/discoveries/${d.id}`,
      clone(d),
    ]),
  ]);
  let writes = 0;
  const snapshot = (path) => ({
    exists: values.has(path),
    data: () => clone(values.get(path)),
    id: path.split('/').at(-1),
  });
  const doc = (path) => ({
    path,
    collection: (name) => collection(`${path}/${name}`),
  });
  const collection = (path) => ({
    doc: (id) => doc(`${path}/${id}`),
    where: () => ({
      orderBy: () => ({
        limit: () => ({
          get: async () => {
            const docs = [...values.keys()]
              .filter(
                (key) =>
                  key.startsWith(path + '/') &&
                  !key.slice(path.length + 1).includes('/') &&
                  values.get(key).status === 'confirmed',
              )
              .map(snapshot);
            return { docs, size: docs.length };
          },
        }),
      }),
    }),
  });
  return {
    values,
    get writes() {
      return writes;
    },
    collection,
    runTransaction: async (fn) =>
      fn({
        get: async (r) => snapshot(r.path),
        update: (r, fields) => {
          writes++;
          values.set(r.path, { ...values.get(r.path), ...fields });
        },
      }),
  };
}

test('metadata backfill defaults to plan, apply is idempotent, never overwrites and prints aggregates only', async () => {
  const d = discovery('d1', { cityOverride: 'Shanghai' });
  const db = backfillDb([google], [d]);
  const before = clone([...db.values]);
  const plan = await backfillPlaceMapMetadata(db, 'fixture');
  assert.equal(plan.mode, 'plan');
  assert.equal(plan.planned, 1);
  assert.equal(db.writes, 0);
  assert.deepEqual([...db.values], before);
  const applied = await backfillPlaceMapMetadata(db, 'fixture', 'apply');
  assert.equal(applied.applied, 1);
  const stored = db.values.get(`workspaces/fixture/places/${google.id}`);
  assert.deepEqual(stored.mapMetadata, {
    city: { value: 'Shanghai', source: 'user' },
    category: { value: 'restaurant', source: 'recognition' },
  });
  assert.equal(stored.label, google.label);
  assert.equal(PlaceSchema.safeParse(stored).success, true);
  assert.equal(
    (await backfillPlaceMapMetadata(db, 'fixture', 'apply')).applied,
    0,
  );
  assert.equal(db.writes, 1);
  const output = JSON.stringify([plan, applied]);
  for (const privateValue of [
    'Shanghai',
    'restaurant',
    'gaga',
    google.id,
    'gid-exact',
    'd1',
    'PROVIDER_LINK',
  ])
    assert.equal(output.includes(privateValue), false, privateValue);
});

test('metadata backfill apply revalidates transactionally and skips a concurrent metadata change', async () => {
  const d = discovery('d1', { cityOverride: 'Shanghai' });
  const db = backfillDb([google], [d]),
    transact = db.runTransaction;
  db.runTransaction = async (fn) => {
    db.values.set(`workspaces/fixture/places/${google.id}`, {
      ...google,
      mapMetadata: { city: { value: 'Concurrent', source: 'user' } },
    });
    return transact(fn);
  };
  const result = await backfillPlaceMapMetadata(db, 'fixture', 'apply');
  assert.equal(result.stale, 1);
  assert.equal(db.writes, 0);
  assert.deepEqual(
    db.values.get(`workspaces/fixture/places/${google.id}`).mapMetadata,
    { city: { value: 'Concurrent', source: 'user' } },
  );
  await assert.rejects(() => backfillPlaceMapMetadata(db, 'fixture', 'write'));
});

test('Google projection exposes only application-owned city/category and never an address; OSM exposes its own address with attribution', async () => {
  const withMetadata = {
    ...google,
    mapMetadata: {
      city: { value: 'Shanghai', source: 'user' },
      category: { value: 'restaurant', source: 'recognition' },
    },
  };
  const bare = googlePlace('google-bare', 'gid-bare', {
    label: 'Eli falafel',
    labelSource: 'recognition',
  });
  const { places } = await new ProjectionService(hydrator).project([
    withMetadata,
    bare,
    osm,
  ]);
  const features = Object.fromEntries(
    geojson(places).features.map((f) => [f.id, f.properties]),
  );
  assert.deepEqual(features[google.id], {
    label: 'gaga',
    tags: [],
    provider: 'google-places',
    category: 'restaurant',
    city: 'Shanghai',
  });
  assert.deepEqual(features['google-bare'], {
    label: 'Eli falafel',
    tags: [],
    provider: 'google-places',
  });
  assert.deepEqual(features[osm.id], {
    label: 'Independent OSM name',
    tags: [],
    provider: 'nominatim',
    attribution:
      '© OpenStreetMap contributors; https://www.openstreetmap.org/copyright',
    category: 'park',
    city: 'Shanghai',
    address: '1 OSM Street, Shanghai',
  });
  const body = serializeProjection('geojson', places);
  for (const prohibited of ['PROHIBITED_', 'gid-exact', 'PROVIDER_LINK'])
    assert.equal(body.includes(prohibited), false, prohibited);
  // The transient model itself refuses a Google feature carrying an address.
  assert.equal(
    ProjectedPlaceSchema.safeParse({ ...places[0], address: 'x' }).success,
    places[0].providerIdentity.provider !== 'google-places',
  );
  assert.equal(
    ProjectedPlaceSchema.safeParse({
      id: 'g',
      label: 'g',
      coordinates: view.coordinates,
      tags: [],
      address: 'PROHIBITED_ADDRESS',
      providerIdentity: { provider: 'google-places', id: 'gid' },
    }).success,
    false,
  );
});

test('additive metadata changes the content ETag only when a feature property changes', async () => {
  const project = async (input) =>
    serializeProjection(
      'geojson',
      (await new ProjectionService(hydrator).project(input)).places,
    );
  const base = await project([google, osm]);
  assert.equal(
    projectionEtag(base),
    projectionEtag(await project([osm, google])),
  );
  const enriched = await project([
    {
      ...google,
      mapMetadata: { category: { value: 'restaurant', source: 'recognition' } },
    },
    osm,
  ]);
  assert.notEqual(projectionEtag(base), projectionEtag(enriched));
  assert.ok(
    MapMetadataSchema.parse({ category: { value: 'x', source: 'user' } }),
  );
});

test('the broader search areaHint never becomes a map city, in confirmation or backfill', () => {
  const areaOnly = {
    visibleText: [],
    clues: [clue('gaga', { areaHint: 'Shanghai', confidence: 0.99 })],
  };
  assert.equal(recognitionCity(areaOnly, 0), undefined);
  assert.deepEqual(mapMetadataFor({ recognition: areaOnly }, {}), {
    category: { value: 'restaurant', source: 'recognition' },
  });
  // A cityHint is read independently of a (different, broader) areaHint.
  const both = {
    visibleText: [],
    clues: [clue('gaga', { areaHint: 'Pudong', cityHint: 'Shanghai' })],
  };
  assert.deepEqual(mapMetadataFor({ recognition: both }, {}).city, {
    value: 'Shanghai',
    source: 'recognition',
  });
  // Historical discoveries carrying only an areaHint are never promoted by the backfill.
  const historical = discovery('legacy', { recognition: areaOnly });
  const plan = planPlaceMapMetadata([google], [historical]);
  assert.deepEqual(plan.updates, [
    {
      placeId: google.id,
      add: { category: { value: 'restaurant', source: 'recognition' } },
      discoveryIds: ['legacy'],
    },
  ]);
  assert.equal(plan.counts.cityUnavailable, 1);
});
