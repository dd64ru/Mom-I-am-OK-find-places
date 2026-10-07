import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { smokeFeed, validateFeedGeojson } from '../scripts/feed-smoke.mjs';
import { handleFeed } from '../apps/functions/dist/feed.js';
import { ProjectionService } from '@places/core';
const feature = {
  type: 'Feature',
  id: 'internal-id',
  geometry: { type: 'Point', coordinates: [20, 10] },
  properties: { label: 'PRIVATE_LABEL', tags: [], provider: 'google-places' },
};
const body = () => ({
  type: 'FeatureCollection',
  features: [structuredClone(feature)],
});
test('owner smoke uses only bounded authenticated reads and reports no token/raw contents, including negative checks', async () => {
  const token = randomBytes(32).toString('base64url');
  const time = '2026-01-01T00:00:00.000Z';
  const identity = { provider: 'google-places', id: 'PRIVATE_GOOGLE_ID' };
  const source = {
    provider: 'google-places',
    externalId: identity.id,
    observedAt: time,
  };
  const calls = [];
  const deps = {
    tokenDigest: async () => createHash('sha256').update(token).digest('hex'),
    readPlaces: async () => ({
      places: [
        {
          id: feature.id,
          workspaceId: 'fixture',
          providerIdentity: identity,
          source,
          evidence: [source],
          label: feature.properties.label,
          labelSource: 'user',
          tags: [],
          status: 'confirmed',
          createdAt: time,
          updatedAt: time,
        },
      ],
      truncated: false,
    }),
    projection: new ProjectionService({
      refresh: async () => ({
        providerIdentity: identity,
        coordinates: { latitude: 10, longitude: 20, crs: 'WGS84' },
      }),
    }),
  };
  const result = await smokeFeed({
    url: 'https://fixture.invalid/placesFeed',
    token,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const response = await handleFeed(
        {
          method: options.method,
          query: Object.fromEntries(url.searchParams),
          authorization: options.headers.Authorization,
          ifNoneMatch: options.headers['If-None-Match'],
        },
        deps,
      );
      return new Response(response.status === 304 ? null : response.body, {
        status: response.status,
        headers: response.headers,
      });
    },
  });
  assert.deepEqual(result, {
    event: 'feed_smoke',
    featureCount: 1,
    total: 1,
    projected: 1,
    complete: true,
    etagSuccess: true,
  });
  assert.equal(calls.length, 6);
  assert.equal(calls[1].options.headers['If-None-Match'].startsWith('"'), true);
  assert.deepEqual(
    calls.map((c) => c.options.method),
    ['GET', 'GET', 'GET', 'GET', 'GET', 'POST'],
  );
  for (const call of calls) {
    assert.equal(call.url.toString().includes(token), false);
    assert.equal(call.options.redirect, 'error');
    assert.ok(call.options.signal);
  }
  for (const value of [
    token,
    feature.id,
    feature.properties.label,
    identity.id,
    'coordinates',
  ])
    assert.equal(JSON.stringify(result).includes(value), false);
});
test('smoke validates unique internal IDs, coordinates and licensed provider property boundaries', () => {
  assert.equal(validateFeedGeojson(body()), 1);
  for (const invalid of [
    { ...body(), features: [feature, feature] },
    { ...body(), crs: 'WGS84' },
    { ...body(), features: [{ ...feature, id: undefined }] },
    {
      ...body(),
      features: [
        { ...feature, geometry: { type: 'Point', coordinates: [181, 10] } },
      ],
    },
    {
      ...body(),
      features: [
        { ...feature, geometry: { type: 'Point', coordinates: [20, -91] } },
      ],
    },
    {
      ...body(),
      features: [
        {
          ...feature,
          properties: {
            ...feature.properties,
            formattedAddress: 'PRIVATE_ADDRESS',
          },
        },
      ],
    },
    {
      ...body(),
      features: [
        {
          ...feature,
          properties: {
            ...feature.properties,
            sourceLink: 'https://private.invalid/',
          },
        },
      ],
    },
  ])
    assert.throws(
      () => validateFeedGeojson(invalid),
      /^Error: feed_smoke_failed$/,
    );
});
test('smoke accepts additive city/category on Google and city/category/address on OSM, but never a Google address', () => {
  const withProps = (properties) => ({
    ...body(),
    features: [{ ...feature, properties }],
  });
  assert.equal(
    validateFeedGeojson(
      withProps({ ...feature.properties, city: 'C', category: 'K' }),
    ),
    1,
  );
  assert.equal(
    validateFeedGeojson(
      withProps({
        label: 'L',
        tags: [],
        provider: 'nominatim',
        city: 'C',
        category: 'K',
        address: 'A',
        attribution: 'OSM',
      }),
    ),
    1,
  );
  for (const properties of [
    { ...feature.properties, address: 'PRIVATE_ADDRESS' },
    { ...feature.properties, city: '' },
    { ...feature.properties, category: 7 },
  ])
    assert.throws(
      () => validateFeedGeojson(withProps(properties)),
      /^Error: feed_smoke_failed$/,
    );
});
test('smoke fails safely on upstream exceptions, rejects credential URLs and never echoes input or response bodies', async () => {
  const token = randomBytes(32).toString('base64url');
  for (const url of [
    'https://fixture.invalid/?token=' + token,
    'http://fixture.invalid/',
    'https://user:password@fixture.invalid/',
  ]) {
    await assert.rejects(
      smokeFeed({
        url,
        token,
        fetchImpl: () => assert.fail('must reject before network'),
      }),
      /^Error: feed_smoke_failed$/,
    );
  }
  await assert.rejects(
    smokeFeed({
      url: 'https://fixture.invalid/',
      token,
      fetchImpl: async () => {
        throw new Error(token + ' PRIVATE_LABEL PRIVATE_BODY');
      },
    }),
    /^Error: feed_smoke_failed$/,
  );
  await assert.rejects(
    smokeFeed({
      url: 'https://fixture.invalid/',
      token,
      fetchImpl: async () =>
        new Response(token + ' PRIVATE_BODY', { status: 503 }),
    }),
    /^Error: feed_smoke_failed$/,
  );
  const source = await readFile(
    new URL('../scripts/feed-smoke.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /console\.log\(\s*JSON\.stringify\(\s*await smokeFeed/);
  assert.match(source, /console\.error\('feed_smoke_failed'\)/);
  assert.doesNotMatch(
    source,
    /console\.(?:log|info|error)\((?:token|body|feature|response|url)/,
  );
});
test('smoke accepts the additive coordinateSystem only when it matches the provider', () => {
  const withProps = (properties) => ({
    ...body(),
    features: [{ ...feature, properties }],
  });
  const osm = { label: 'L', tags: [], provider: 'osm' };
  assert.equal(
    validateFeedGeojson(
      withProps({ ...feature.properties, coordinateSystem: 'gcj02' }),
    ),
    1,
  );
  assert.equal(
    validateFeedGeojson(withProps({ ...osm, coordinateSystem: 'wgs84' })),
    1,
  );
  // Absent (an older feed) stays valid.
  assert.equal(validateFeedGeojson(withProps(osm)), 1);
  for (const properties of [
    { ...feature.properties, coordinateSystem: 'wgs84' },
    { ...osm, coordinateSystem: 'gcj02' },
    { ...osm, coordinateSystem: 'bd09' },
  ])
    assert.throws(
      () => validateFeedGeojson(withProps(properties)),
      /^Error: feed_smoke_failed$/,
    );
});
