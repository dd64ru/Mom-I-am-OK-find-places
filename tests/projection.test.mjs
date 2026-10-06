import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import {
  ProjectionService,
  geojson,
  gpx,
  kml,
  planPlaceLabels,
  serializeProjection,
} from '@places/core';
import {
  PlaceSchema,
  DiscoverySchema,
  recognitionLabel,
} from '@places/schemas';
import {
  handleFeed,
  validFeedToken,
  projectionEtag,
} from '../apps/functions/dist/feed.js';
import {
  backfillArguments,
  backfillPlaceLabels,
} from '../scripts/backfill-place-labels.mjs';
const time = '2026-01-01T00:00:00.000Z';
const reference = {
  provider: 'google-places',
  externalId: 'opaque-provider-id',
  url: 'https://example.org/PROVIDER_LINK',
  observedAt: time,
};
const google = {
  id: 'google-place',
  workspaceId: 'fixture',
  providerIdentity: { provider: 'google-places', id: reference.externalId },
  source: reference,
  evidence: [reference],
  status: 'confirmed',
  tags: ['personal'],
  createdAt: time,
  updatedAt: time,
};
const osm = {
  id: 'osm-place',
  workspaceId: 'fixture',
  canonicalName: 'Independent OSM name',
  aliases: [],
  category: 'park',
  coordinates: { latitude: 12.5, longitude: -45.25, crs: 'WGS84' },
  address: { formatted: 'OSM address' },
  source: { provider: 'nominatim', externalId: 'node:123', observedAt: time },
  evidence: [
    { provider: 'nominatim', externalId: 'node:123', observedAt: time },
  ],
  confidence: 0.9,
  status: 'confirmed',
  tags: [],
  createdAt: time,
  updatedAt: time,
};
const discovery = {
  id: 'confirmed-discovery',
  workspaceId: 'fixture',
  source: { provider: 'telegram', observedAt: time },
  recognition: {
    visibleText: [],
    clues: [
      {
        name: 'Happy Harbour',
        aliases: ['OH Bay'],
        category: 'landmark',
        confidence: 0.95,
      },
    ],
  },
  candidates: [
    {
      resolution: 'deterministic_poi',
      providerIdentity: google.providerIdentity,
      references: [reference],
    },
  ],
  visionProvider: 'fixture-vision',
  status: 'confirmed',
  revision: 3,
  confirmedPlaceId: google.id,
  createdAt: time,
  updatedAt: time,
};
const labeled = {
  ...google,
  label: 'Happy Harbour',
  labelSource: 'recognition',
};
const view = {
  canonicalName: 'PROHIBITED_DISPLAY',
  coordinates: { latitude: 22.55, longitude: 113.89, crs: 'WGS84' },
  address: { formatted: 'PROHIBITED_ADDRESS' },
  category: 'PROHIBITED_CATEGORY',
  types: ['PROHIBITED_TYPES'],
  attributions: [
    {
      provider: 'PROHIBITED_CREDIT',
      providerUri: 'https://example.org/PROHIBITED_CREDIT',
    },
  ],
  providerIdentity: google.providerIdentity,
};
const clone = structuredClone;
test('legacy production-shaped Google Place parses; optional label is an atomic independent provenance pair', () => {
  assert.deepEqual(PlaceSchema.parse(google), google);
  assert.equal(PlaceSchema.parse(labeled).labelSource, 'recognition');
  assert.equal(
    PlaceSchema.safeParse({ ...google, label: 'orphan' }).success,
    false,
  );
  assert.equal(
    PlaceSchema.safeParse({ ...google, labelSource: 'recognition' }).success,
    false,
  );
  assert.equal(
    PlaceSchema.safeParse({
      ...google,
      label: 'bad',
      labelSource: 'google-places',
    }).success,
    false,
  );
  for (const field of [
    'canonicalName',
    'formattedAddress',
    'coordinates',
    'types',
    'attributions',
  ])
    assert.equal(
      PlaceSchema.safeParse({
        ...labeled,
        [field]: view[field] ?? 'provider-content',
      }).success,
      false,
    );
});
test('recognition label uses selected independent clue; unbound multi-clue recognition is unresolved', () => {
  const r = {
    ...discovery.recognition,
    clues: [
      { ...discovery.recognition.clues[0], name: 'Wrong clue' },
      discovery.recognition.clues[0],
    ],
  };
  assert.equal(recognitionLabel(r), undefined);
  assert.deepEqual(recognitionLabel(r, 1), {
    label: 'Happy Harbour',
    labelSource: 'recognition',
  });
  assert.equal(recognitionLabel(r, 9), undefined);
});
test('backfill pure plan derives Happy Harbour only from associated confirmed independent recognition', () => {
  const plan = planPlaceLabels([google], [discovery]);
  assert.deepEqual(plan.updates, [
    {
      placeId: google.id,
      label: 'Happy Harbour',
      labelSource: 'recognition',
      discoveryIds: [discovery.id],
    },
  ]);
  assert.equal(google.label, undefined);
  for (const d of [
    { ...discovery, status: 'cancelled', confirmedPlaceId: undefined },
    { ...discovery, confirmedPlaceId: 'other-place' },
    { ...discovery, workspaceId: 'other-workspace' },
    { ...discovery, recognition: { visibleText: [], clues: [] } },
  ])
    assert.equal(planPlaceLabels([google], [d]).counts.unresolved, 1);
});
test('backfill preserves user/recognition labels and refuses contradictory or ambiguous independent clues', () => {
  const user = { ...google, label: 'My harbour', labelSource: 'user' };
  assert.equal(planPlaceLabels([user], [discovery]).counts.alreadyLabeled, 1);
  const different = {
    ...discovery,
    id: 'other-discovery',
    recognition: {
      ...discovery.recognition,
      clues: [{ ...discovery.recognition.clues[0], name: 'Different place' }],
    },
  };
  assert.equal(
    planPlaceLabels([google], [discovery, different]).counts.unresolved,
    1,
  );
  const multi = {
    ...discovery,
    recognition: {
      ...discovery.recognition,
      clues: [...discovery.recognition.clues, different.recognition.clues[0]],
    },
  };
  assert.equal(planPlaceLabels([google], [multi]).counts.unresolved, 1);
  assert.equal(
    planPlaceLabels(
      [google],
      [
        {
          ...multi,
          candidates: [{ ...multi.candidates[0], recognitionClueIndex: 0 }],
        },
      ],
    ).counts.planned,
    1,
  );
});
function backfillDb() {
  const values = new Map([
    [`workspaces/fixture/places/${google.id}`, clone(google)],
    [`workspaces/fixture/discoveries/${discovery.id}`, clone(discovery)],
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
        get: async (ref) => snapshot(ref.path),
        update: (ref, fields) => {
          writes++;
          values.set(ref.path, { ...values.get(ref.path), ...fields });
        },
      }),
  };
}
test('backfill CLI defaults to plan; plan never mutates and explicit apply is idempotent in a local fake database', async () => {
  assert.equal(
    backfillArguments([
      '--project',
      'fixture-project',
      '--workspace',
      'fixture',
    ]).mode,
    'plan',
  );
  assert.throws(() =>
    backfillArguments([
      '--project',
      'fixture-project',
      '--workspace',
      'fixture',
      '--plan',
      '--apply',
    ]),
  );
  const db = backfillDb();
  const before = clone([...db.values]);
  const plan = await backfillPlaceLabels(db, 'fixture');
  assert.equal(plan.planned, 1);
  assert.equal(db.writes, 0);
  assert.deepEqual([...db.values], before);
  const result = await backfillPlaceLabels(db, 'fixture', 'apply');
  assert.equal(result.applied, 1);
  assert.equal(db.writes, 1);
  assert.equal(
    db.values.get(`workspaces/fixture/places/${google.id}`).label,
    'Happy Harbour',
  );
  assert.equal((await backfillPlaceLabels(db, 'fixture', 'apply')).applied, 0);
  assert.equal(db.writes, 1);
  const output = JSON.stringify([plan, result]);
  for (const privateValue of [
    'Happy Harbour',
    google.id,
    google.providerIdentity.id,
    reference.url,
  ])
    assert.equal(output.includes(privateValue), false);
});
test('backfill apply revalidates the Place transactionally and never overwrites a concurrent user label', async () => {
  const db = backfillDb(),
    transact = db.runTransaction;
  db.runTransaction = async (fn) => {
    db.values.set(`workspaces/fixture/places/${google.id}`, {
      ...google,
      label: 'Concurrent user label',
      labelSource: 'user',
    });
    return transact(fn);
  };
  const result = await backfillPlaceLabels(db, 'fixture', 'apply');
  assert.equal(result.stale, 1);
  assert.equal(db.writes, 0);
});
test('projection uses durable OSM and transient refreshed Google coordinates; missing labels and failed refresh skip safely', async () => {
  const input = [
    osm,
    labeled,
    {
      ...labeled,
      id: 'failed-google',
      providerIdentity: { provider: 'google-places', id: 'failed-id' },
      source: { ...reference, externalId: 'failed-id' },
    },
    { ...google, id: 'legacy-unlabeled' },
    { ...osm, id: 'archived', status: 'archived' },
  ];
  const before = clone(input),
    calls = [];
  const result = await new ProjectionService({
    refresh: async (identity) => {
      calls.push(identity.id);
      if (identity.id === 'failed-id') throw new Error('PRIVATE_PROVIDER_BODY');
      return clone(view);
    },
  }).project(input);
  assert.deepEqual(input, before);
  assert.deepEqual(
    result.places.map((p) => p.id),
    ['google-place', 'osm-place'],
  );
  assert.deepEqual(result.places[0].coordinates, view.coordinates);
  assert.deepEqual(result.places[1].coordinates, osm.coordinates);
  assert.equal(result.places[0].label, 'Happy Harbour');
  assert.equal(result.counts.googleHydrated, 1);
  assert.equal(result.counts.providerFailures, 1);
  assert.equal(result.counts.missingLabels, 1);
  assert.equal(calls.length, 2);
  assert.equal(JSON.stringify(result).includes('PROHIBITED_'), false);
  // OSM may expose its own independently licensed address; Google never does.
  for (const prohibited of ['address', 'attributions', 'types'])
    assert.equal(JSON.stringify(result.places[0]).includes(prohibited), false);
});
test('identity mismatch and malformed hydrated coordinates cannot enter projection', async () => {
  for (const returned of [
    { ...view, providerIdentity: { provider: 'google-places', id: 'wrong' } },
    { ...view, coordinates: { ...view.coordinates, latitude: 91 } },
  ]) {
    const result = await new ProjectionService({
      refresh: async () => returned,
    }).project([labeled, osm]);
    assert.equal(result.counts.providerFailures, 1);
    assert.deepEqual(
      result.places.map((p) => p.id),
      ['osm-place'],
    );
  }
});
test('hydration concurrency is bounded at four and a stalled provider cannot stall the feed', async () => {
  let active = 0,
    maximum = 0;
  const places = Array.from({ length: 9 }, (_, i) => ({
    ...labeled,
    id: `google-${i}`,
  }));
  await new ProjectionService({
    refresh: async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      return view;
    },
  }).project(places);
  assert.equal(maximum, 4);
  const stalled = await new ProjectionService(
    { refresh: () => new Promise(() => {}) },
    { refreshTimeoutMs: 2, budgetMs: 5, concurrency: 1 },
  ).project(places);
  assert.equal(stalled.places.length, 0);
  assert.equal(
    stalled.counts.providerFailures + stalled.counts.budgetSkipped,
    9,
  );
});
let projected;
async function sampleProjection() {
  return (projected ??= (
    await new ProjectionService({ refresh: async () => view }).project([
      osm,
      labeled,
    ])
  ).places);
}
test('GeoJSON is an RFC 7946 FeatureCollection with stable IDs and longitude,latitude order', async () => {
  const result = geojson(await sampleProjection());
  assert.equal(result.type, 'FeatureCollection');
  assert.deepEqual(result.features[0].geometry, {
    type: 'Point',
    coordinates: [113.89, 22.55],
  });
  assert.equal(result.features[0].id, google.id);
  assert.deepEqual(result.features[0].properties, {
    label: 'Happy Harbour',
    tags: ['personal'],
    provider: 'google-places',
  });
  assert.equal('crs' in result, false);
});
function parseXml(body) {
  return JSON.parse(
    execFileSync(
      'python3',
      [
        '-c',
        'import json,sys,xml.etree.ElementTree as E; r=E.fromstring(sys.stdin.read()); print(json.dumps({"tag":r.tag,"attrib":r.attrib,"nodes":[{"tag":n.tag,"attrib":n.attrib,"text":n.text} for n in r.iter()]}))',
      ],
      { input: body, encoding: 'utf8' },
    ),
  );
}
test('GPX 1.1 waypoints and KML placemarks are valid namespace-aware XML with safe labels', async () => {
  const points = clone(await sampleProjection());
  points[0].label = 'Happy <Harbour> & "OH Bay"';
  const gp = parseXml(gpx(points)),
    km = parseXml(kml(points));
  assert.equal(gp.tag, '{http://www.topografix.com/GPX/1/1}gpx');
  assert.equal(gp.attrib.version, '1.1');
  const waypoint = gp.nodes.find((n) => n.tag.endsWith('}wpt'));
  assert.deepEqual(waypoint.attrib, { lat: '22.55', lon: '113.89' });
  assert.equal(
    gp.nodes.find((n) => n.tag.endsWith('}name')).text,
    points[0].label,
  );
  assert.equal(km.tag, '{http://www.opengis.net/kml/2.2}kml');
  assert.equal(km.nodes.filter((n) => n.tag.endsWith('}Placemark')).length, 2);
  assert.equal(
    km.nodes.find((n) => n.tag.endsWith('}coordinates')).text,
    '113.89,22.55',
  );
});
test('all adapters share deterministic ordering and omit Google display/address/types/attributions', async () => {
  const places = await sampleProjection();
  for (const format of ['geojson', 'gpx', 'kml']) {
    const output = serializeProjection(format, places);
    assert.equal(output, serializeProjection(format, [...places].reverse()));
    for (const privateContent of [
      'PROHIBITED_',
      reference.url,
      google.providerIdentity.id,
    ])
      assert.equal(output.includes(privateContent), false);
  }
});
function feedFixture() {
  const token = randomBytes(32).toString('base64url');
  let digest = createHash('sha256').update(token).digest('hex');
  let reads = 0,
    refreshes = 0;
  const events = [],
    inputs = clone([osm, labeled]);
  const deps = {
    allowUrlToken: true,
    tokenDigest: async () => digest,
    readPlaces: async (limit) => {
      reads++;
      assert.equal(limit, 100);
      return { places: inputs, truncated: false };
    },
    projection: new ProjectionService({
      refresh: async () => {
        refreshes++;
        return view;
      },
    }),
    diagnostic: (e) => events.push(e),
  };
  return {
    token,
    deps,
    events,
    inputs,
    get reads() {
      return reads;
    },
    get refreshes() {
      return refreshes;
    },
    rotate: () => {
      digest = createHash('sha256').update(randomBytes(32)).digest('hex');
    },
  };
}
test('feed rejects unauthorized callers and unsupported methods before Firestore/provider access', async () => {
  const f = feedFixture();
  for (const token of [undefined, 'wrong', [f.token], f.token.slice(1)])
    assert.equal(
      (await handleFeed({ method: 'GET', query: { token } }, f.deps)).status,
      401,
    );
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
    const result = await handleFeed(
      { method, query: { token: f.token } },
      f.deps,
    );
    assert.equal(result.status, 405);
    assert.equal(result.headers.Allow, 'GET');
  }
  assert.equal(f.reads, 0);
  assert.equal(f.refreshes, 0);
  assert.deepEqual(f.events, []);
});
test('feed accepts URL token or Authorization for one workspace; latest hash rotation immediately revokes old token', async () => {
  const f = feedFixture();
  assert.equal(validFeedToken(f.token, await f.deps.tokenDigest()), true);
  assert.equal(
    (
      await handleFeed(
        { method: 'GET', query: {}, authorization: `Bearer ${f.token}` },
        f.deps,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await handleFeed(
        {
          method: 'GET',
          query: { token: f.token, workspace: 'other-workspace' },
        },
        f.deps,
      )
    ).status,
    400,
  );
  f.rotate();
  assert.equal(
    (await handleFeed({ method: 'GET', query: { token: f.token } }, f.deps))
      .status,
    401,
  );
});
test('feed formats, private cache headers and ETag/304 are deterministic and authenticated', async () => {
  const f = feedFixture();
  const before = clone(f.inputs);
  for (const [format, contentType] of [
    ['geojson', 'application/geo+json'],
    ['gpx', 'application/gpx+xml'],
    ['kml', 'application/vnd.google-earth.kml+xml'],
  ]) {
    const req = { method: 'GET', query: { token: f.token, format } };
    const first = await handleFeed(req, f.deps),
      second = await handleFeed(req, f.deps);
    assert.equal(first.status, 200);
    assert.ok(first.headers['Content-Type'].startsWith(contentType));
    assert.match(first.headers['Cache-Control'], /private, no-cache/u);
    assert.equal(first.headers.ETag, second.headers.ETag);
    assert.equal(first.headers.ETag, projectionEtag(first.body));
    assert.equal(
      (
        await handleFeed(
          { ...req, ifNoneMatch: `"unrelated", W/${first.headers.ETag}` },
          f.deps,
        )
      ).status,
      304,
    );
    assert.equal(
      (await handleFeed({ ...req, ifNoneMatch: first.headers.ETag }, f.deps))
        .body,
      '',
    );
    assert.equal(
      (
        await handleFeed(
          { ...req, query: {}, ifNoneMatch: first.headers.ETag },
          f.deps,
        )
      ).status,
      401,
    );
  }
  assert.deepEqual(f.inputs, before);
  const logs = JSON.stringify(f.events);
  for (const prohibited of [
    f.token,
    'Happy Harbour',
    google.providerIdentity.id,
    'PROHIBITED_',
    reference.url,
    '22.55',
    '113.89',
  ])
    assert.equal(logs.includes(prohibited), false);
  assert.deepEqual(
    Object.keys(f.events[0]).sort(),
    [
      'event',
      'format',
      'placesTotal',
      'placesProjected',
      'googleHydrated',
      'providerFailures',
      'missingLabels',
      'invalidPlaces',
      'budgetSkipped',
      'truncated',
    ].sort(),
  );
});
test('partial feed succeeds with aggregate provider failure; invalid format, unavailable secrets and feed limit fail safely', async () => {
  const f = feedFixture();
  f.deps.projection = new ProjectionService({
    refresh: async () => {
      throw new Error(f.token);
    },
  });
  const result = await handleFeed(
    { method: 'GET', query: { token: f.token } },
    f.deps,
  );
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(result.body).features.length, 1);
  assert.equal(f.events[0].providerFailures, 1);
  assert.equal(
    (
      await handleFeed(
        { method: 'GET', query: { token: f.token, format: 'bad' } },
        f.deps,
      )
    ).status,
    400,
  );
  f.deps.readPlaces = async () => ({ places: [], truncated: true });
  assert.equal(
    (await handleFeed({ method: 'GET', query: { token: f.token } }, f.deps))
      .body,
    'feed_limit_exceeded',
  );
  f.deps.tokenDigest = async () => {
    throw new Error(f.token);
  };
  const unavailable = await handleFeed(
    { method: 'GET', query: { token: f.token } },
    f.deps,
  );
  assert.equal(unavailable.status, 503);
  assert.equal(JSON.stringify(unavailable).includes(f.token), false);
});
test('separate feed defaults disabled and exposes no write ports; webhook-only deployment and IAM are unchanged', async () => {
  const index = await readFile(
    new URL('../apps/functions/src/feed-entry.ts', import.meta.url),
    'utf8',
  );
  const runtime = await readFile(
    new URL('../apps/functions/src/feed-runtime.ts', import.meta.url),
    'utf8',
  );
  const workflow = await readFile(
    new URL('../.github/workflows/deploy.yml', import.meta.url),
    'utf8',
  );
  assert.match(index, /export const placesFeed = onRequest/u);
  assert.match(index, /PLACES_FEED_ENABLED.*default: 'false'/u);
  assert.doesNotMatch(
    runtime,
    /\.set\(|\.update\(|\.create\(|runTransaction|FirestoreRepository/u,
  );
  assert.match(workflow, /--only functions:places:placesWebhook/u);
});

test('URL bearer tokens require separate opt-in, while Authorization supports private downloads without putting tokens in URLs', async () => {
  const f = feedFixture();
  f.deps.allowUrlToken = false;
  assert.equal(
    (await handleFeed({ method: 'GET', query: { token: f.token } }, f.deps))
      .status,
    401,
  );
  assert.equal(
    (
      await handleFeed(
        { method: 'GET', query: {}, authorization: `Bearer ${f.token}` },
        f.deps,
      )
    ).status,
    200,
  );
});

test('backfill refuses multi-candidate or mismatched Google identity associations', () => {
  assert.equal(
    planPlaceLabels(
      [google],
      [
        {
          ...discovery,
          candidates: [...discovery.candidates, discovery.candidates[0]],
        },
      ],
    ).counts.unresolved,
    1,
  );
  const different = { provider: 'google-places', id: 'different-provider-id' };
  const candidate = {
    ...discovery.candidates[0],
    providerIdentity: different,
    references: [{ ...reference, externalId: different.id }],
  };
  assert.equal(
    planPlaceLabels([google], [{ ...discovery, candidates: [candidate] }])
      .counts.unresolved,
    1,
  );
});

test('OSM exports retain fixed licensing credit without transferring Google attribution', async () => {
  const places = await sampleProjection();
  const features = geojson(places).features;
  assert.equal(features[0].properties.attribution, undefined);
  assert.match(
    features[1].properties.attribution,
    /OpenStreetMap contributors/u,
  );
  assert.equal(
    parseXml(gpx(places)).nodes.filter((n) => n.tag.endsWith('}desc')).length,
    1,
  );
  assert.equal(
    parseXml(kml(places)).nodes.filter((n) => n.tag.endsWith('}description'))
      .length,
    1,
  );
  for (const format of ['geojson', 'gpx', 'kml'])
    assert.equal(
      serializeProjection(format, [places[0]]).includes('OpenStreetMap'),
      false,
    );
});

const bearerRequest = (f) => ({
  method: 'GET',
  query: { format: 'geojson' },
  authorization: `Bearer ${f.token}`,
});
function assertSnapshot(response, total, projected, complete) {
  assert.equal(response.headers['X-Places-Feed-Version'], '1');
  assert.equal(response.headers['X-Places-Total'], String(total));
  assert.equal(response.headers['X-Places-Projected'], String(projected));
  assert.equal(
    response.headers['X-Places-Snapshot-Complete'],
    String(complete),
  );
}
test('v1 authenticated snapshot and conditional 304 expose complete content-free aggregates', async () => {
  const f = feedFixture();
  f.deps.allowUrlToken = false;
  const first = await handleFeed(bearerRequest(f), f.deps);
  assert.equal(first.status, 200);
  assertSnapshot(first, 2, 2, true);
  const second = await handleFeed(
    { ...bearerRequest(f), ifNoneMatch: first.headers.ETag },
    f.deps,
  );
  assert.equal(second.status, 304);
  assertSnapshot(second, 2, 2, true);
  assert.equal(second.body, '');
  const aggregate = JSON.stringify({
    headers: first.headers,
    events: f.events,
  });
  for (const value of [
    f.token,
    labeled.label,
    google.id,
    reference.externalId,
    reference.url,
    'PROHIBITED_',
    '113.89',
    '22.55',
  ])
    assert.equal(aggregate.includes(value), false);
});
for (const reason of [
  'providerFailures',
  'missingLabels',
  'invalidPlaces',
  'budgetSkipped',
]) {
  test(`v1 marks ${reason} as incomplete on 200 and 304 while preserving siblings`, async () => {
    const f = feedFixture();
    if (reason === 'providerFailures')
      f.deps.projection = new ProjectionService({
        refresh: async () => {
          throw new Error('PRIVATE_PROVIDER_BODY');
        },
      });
    if (reason === 'missingLabels') f.inputs[1] = clone(google);
    if (reason === 'invalidPlaces') f.inputs[1] = { ...labeled, tags: 123 };
    if (reason === 'budgetSkipped') {
      let clock = 0;
      f.deps.projection = new ProjectionService(
        {
          refresh: async () => {
            assert.fail('expired budget must not refresh');
          },
        },
        { now: () => (clock += 100), budgetMs: 1 },
      );
    }
    const first = await handleFeed(bearerRequest(f), f.deps);
    assert.equal(first.status, 200);
    assertSnapshot(first, 2, 1, false);
    assert.equal(JSON.parse(first.body).features[0].id, osm.id);
    assert.equal(f.events[0][reason], 1);
    const second = await handleFeed(
      { ...bearerRequest(f), ifNoneMatch: first.headers.ETag },
      f.deps,
    );
    assert.equal(second.status, 304);
    assertSnapshot(second, 2, 1, false);
  });
}
test('truncation and over-limit snapshots remain hard failures; empty complete snapshots are valid', async () => {
  const f = feedFixture();
  for (const source of [
    { places: [osm], truncated: true },
    { places: Array(101).fill(osm), truncated: false },
  ]) {
    f.deps.readPlaces = async () => source;
    const result = await handleFeed(bearerRequest(f), f.deps);
    assert.equal(result.status, 503);
    assert.equal(result.body, 'feed_limit_exceeded');
    assert.equal(result.headers['X-Places-Snapshot-Complete'], undefined);
  }
  f.deps.readPlaces = async () => ({ places: [], truncated: false });
  assertSnapshot(await handleFeed(bearerRequest(f), f.deps), 0, 0, true);
});
test('valid equal-size incorrect tokens fail; canonical base64url and constant-time hash comparison remain required', async () => {
  const f = feedFixture();
  const digest = await f.deps.tokenDigest();
  assert.equal(
    validFeedToken(randomBytes(32).toString('base64url'), digest),
    false,
  );
  assert.equal(validFeedToken(f.token + '=', digest), false);
  assert.equal(validFeedToken(f.token, digest.toUpperCase()), false);
  const source = await readFile(
    new URL('../apps/functions/src/feed.ts', import.meta.url),
    'utf8',
  );
  assert.match(
    source,
    /timingSafeEqual\(actual, Buffer.from\(digest, 'hex'\)\)/,
  );
});
test('multi-confirmation backfill binds each independent clue by provider identity and refuses related/duplicate/unassociated identities', () => {
  const secondIdentity = {
    provider: 'google-places',
    id: 'second-provider-id',
  };
  const relatedIdentity = {
    provider: 'google-places',
    id: 'related-provider-id',
  };
  const identities = [google.providerIdentity, secondIdentity, relatedIdentity];
  const places = identities.map((providerIdentity, i) => ({
    ...google,
    id: `saved-${i}`,
    providerIdentity,
    source: { ...reference, externalId: providerIdentity.id },
  }));
  const d = {
    ...discovery,
    confirmedPlaceId: places[0].id,
    confirmedPlaceIds: places.map((p) => p.id),
    recognition: {
      visibleText: [],
      clues: [
        discovery.recognition.clues[0],
        { ...discovery.recognition.clues[0], name: 'Independent Gallery' },
      ],
    },
    candidates: identities.map((providerIdentity, i) => ({
      ...discovery.candidates[0],
      providerIdentity,
      recognitionClueIndex: i === 1 ? 1 : 0,
      relationship: i === 2 ? 'related_chain_location' : 'likely_exact',
      references: [{ ...reference, externalId: providerIdentity.id }],
    })),
  };
  const plan = planPlaceLabels(places, [d]);
  assert.deepEqual(
    plan.updates.map((p) => [p.placeId, p.label]),
    [
      [places[0].id, 'Happy Harbour'],
      [places[1].id, 'Independent Gallery'],
    ],
  );
  assert.equal(plan.counts.unresolved, 1);
  const duplicate = {
    ...d,
    candidates: [
      ...d.candidates,
      { ...d.candidates[0], recognitionClueIndex: 1 },
    ],
  };
  assert.equal(planPlaceLabels([places[0]], [duplicate]).counts.unresolved, 1);
  assert.equal(
    planPlaceLabels([{ ...places[0], id: 'unassociated' }], [d]).counts
      .unresolved,
    1,
  );
});

test('unknown provider strings and malformed raw documents never enter the v1 provider enum', async () => {
  const f = feedFixture();
  f.inputs.push(
    {
      ...osm,
      id: 'unknown-provider',
      source: { ...osm.source, provider: 'PRIVATE_PROVIDER_TEXT' },
    },
    null,
  );
  const result = await handleFeed(bearerRequest(f), f.deps);
  assertSnapshot(result, 4, 2, false);
  assert.equal(f.events[0].invalidPlaces, 2);
  assert.equal(JSON.stringify(result).includes('PRIVATE_PROVIDER_TEXT'), false);
});
