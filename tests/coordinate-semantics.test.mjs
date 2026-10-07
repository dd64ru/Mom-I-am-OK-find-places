// Map-data alignment, not provider name, decides whether a projected point moves. A Places API
// location is WGS84 but aligned to Google's map data, which is GCJ-02-offset inside mainland
// China; projection corrects such a point once to its standard WGS84 position. Google points
// elsewhere (Hong Kong, Macao and Taiwan included) and stored OSM/Nominatim coordinates are
// emitted unchanged, and serializers never convert. Synthetic fixtures only; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  ProjectionService,
  gcj02ToWgs84,
  geojson,
  gpx,
  isInMainlandChina,
  kml,
  standardWgs84Position,
  wgs84Position,
  wgs84ToGcj02,
} from '@places/core';
import { CoordinatesSchema } from '@places/schemas';
import { row, googleFixture } from './fixtures/google-places.mjs';

const time = '2026-01-01T00:00:00.000Z';
const REGION_DATA_SHA256 =
  '55bc0c39506baf8f1f43b91ddc30ded87f85aa8cf95d458fecf2a523063062e5';
// The reported Shanghai hotel's Google-map-aligned numbers, used only as a numeric fixture.
const NOVOTEL_GOOGLE = { latitude: 31.2394719, longitude: 121.5248297 };
const NOVOTEL_WGS84 = {
  latitude: 31.241546040991206,
  longitude: 121.52047036546726,
};
const STUTTGART = { latitude: 48.7758459, longitude: 9.1829321 };
const HONG_KONG = { latitude: 22.2988, longitude: 114.1722 };
const MACAU = { latitude: 22.1987, longitude: 113.5439 };
const TAIPEI = { latitude: 25.0339, longitude: 121.5645 };
const near = (actual, expected, label) => {
  assert.ok(
    Math.abs(actual.latitude - expected.latitude) < 1e-9 &&
      Math.abs(actual.longitude - expected.longitude) < 1e-9,
    `${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
  );
};

const googlePlace = {
  id: 'google-place',
  workspaceId: 'fixture',
  providerIdentity: { provider: 'google-places', id: row.id },
  source: { provider: 'google-places', externalId: row.id, observedAt: time },
  evidence: [
    { provider: 'google-places', externalId: row.id, observedAt: time },
  ],
  status: 'confirmed',
  tags: [],
  label: 'Synthetic hotel',
  labelSource: 'recognition',
  createdAt: time,
  updatedAt: time,
};
const osmPlace = (coordinates) => ({
  id: 'osm-place',
  workspaceId: 'fixture',
  canonicalName: 'Synthetic park',
  aliases: [],
  category: 'park',
  coordinates: { ...coordinates, crs: 'WGS84' },
  address: { formatted: 'Synthetic OSM address' },
  source: { provider: 'nominatim', externalId: 'node:1', observedAt: time },
  evidence: [{ provider: 'nominatim', externalId: 'node:1', observedAt: time }],
  confidence: 0.9,
  status: 'confirmed',
  tags: [],
  createdAt: time,
  updatedAt: time,
});

// The real Google refresh adapter, fed a Places API response through a fetch double.
const refreshAdapter = (location) =>
  googleFixture(
    undefined,
    async () => new Response(JSON.stringify({ ...row, location })),
  );
const projectGoogle = async (location) => {
  const { places } = await new ProjectionService(
    refreshAdapter(location),
  ).project([googlePlace]);
  assert.equal(places.length, 1);
  return places[0];
};

test('a Google Places point in mainland China reaches the RFC 7946 feed as its standard WGS84 position', async () => {
  const view = await refreshAdapter(NOVOTEL_GOOGLE).refresh(
    googlePlace.providerIdentity,
  );
  // The adapter states the Places API contract unchanged; the correction is projection's.
  assert.deepEqual(view.coordinates, { ...NOVOTEL_GOOGLE, crs: 'WGS84' });
  const place = await projectGoogle(NOVOTEL_GOOGLE);
  assert.equal(place.coordinates.crs, 'WGS84');
  near(place.coordinates, NOVOTEL_WGS84, 'projected');
  const [feature] = geojson([place]).features;
  const [longitude, latitude] = feature.geometry.coordinates;
  near({ latitude, longitude }, NOVOTEL_WGS84, 'GeoJSON geometry');
  assert.equal(longitude.toFixed(9), '121.520470365');
  assert.equal(latitude.toFixed(9), '31.241546041');
  // About 470 m north-west of the Google-map-aligned pair.
  assert.ok(latitude > NOVOTEL_GOOGLE.latitude);
  assert.ok(longitude < NOVOTEL_GOOGLE.longitude);
});

test('GPX and KML carry the same final WGS84 numbers as the GeoJSON geometry', async () => {
  const place = await projectGoogle(NOVOTEL_GOOGLE);
  const { latitude, longitude } = place.coordinates;
  assert.match(
    gpx([place]),
    new RegExp(`<wpt lat="${latitude}" lon="${longitude}">`),
  );
  assert.match(
    kml([place]),
    new RegExp(`<coordinates>${longitude},${latitude}</coordinates>`),
  );
  assert.equal(gpx([place]).includes(String(NOVOTEL_GOOGLE.longitude)), false);
});

test('Google points outside mainland China, Hong Kong, Macao and Taiwan included, are unchanged', async () => {
  for (const [label, location] of Object.entries({
    STUTTGART,
    HONG_KONG,
    MACAU,
    TAIPEI,
  })) {
    const place = await projectGoogle(location);
    assert.deepEqual(place.coordinates, { ...location, crs: 'WGS84' }, label);
    assert.deepEqual(
      geojson([place]).features[0].geometry.coordinates,
      [location.longitude, location.latitude],
      label,
    );
  }
});

test('stored OSM/Nominatim coordinates in Shanghai are standard WGS84 and unchanged', async () => {
  const osm = osmPlace({ latitude: 31.23, longitude: 121.47 });
  const { places } = await new ProjectionService(
    refreshAdapter(NOVOTEL_GOOGLE),
  ).project([googlePlace, osm]);
  const projected = places.find((p) => p.id === 'osm-place');
  assert.deepEqual(projected.coordinates, osm.coordinates);
  assert.deepEqual(
    geojson(places).features.find((f) => f.id === 'osm-place').geometry
      .coordinates,
    [121.47, 31.23],
  );
});

test('the correction is applied exactly once: re-projection and serializers never convert again', async () => {
  const first = await projectGoogle(NOVOTEL_GOOGLE);
  const second = await projectGoogle(NOVOTEL_GOOGLE);
  assert.deepEqual(second, first);
  // Serializing the projected point emits exactly its numbers, twice in a row.
  const once = geojson([first]);
  assert.deepEqual(once, geojson([first]));
  assert.deepEqual(once.features[0].geometry.coordinates, [
    first.coordinates.longitude,
    first.coordinates.latitude,
  ]);
  // A second correction would move it another ~470 m; it is not what was emitted.
  const twice = gcj02ToWgs84(first.coordinates);
  assert.ok(Math.abs(twice.latitude - first.coordinates.latitude) > 1e-3);
  // The forward formula maps the emitted point back onto the Google-map-aligned pair.
  near(wgs84ToGcj02(first.coordinates), NOVOTEL_GOOGLE, 'round trip');
});

test('no alignment or coordinate-system property reaches a projected place or a feed feature', async () => {
  const place = await projectGoogle(NOVOTEL_GOOGLE);
  for (const key of ['coordinateSystem', 'coordinateAlignment', 'alignment'])
    assert.equal(key in place, false, key);
  const collection = geojson([place]);
  assert.equal('crs' in collection, false, 'RFC 7946: no CRS member');
  const text = JSON.stringify(collection).toLowerCase();
  for (const word of ['gcj', 'alignment', 'coordinatesystem', 'mainland'])
    assert.equal(text.includes(word), false, word);
});

test('a coordinate that is not WGS84 can neither enter a projection nor be serialized', async () => {
  assert.equal(
    CoordinatesSchema.safeParse({ ...NOVOTEL_GOOGLE, crs: 'GCJ02' }).success,
    false,
  );
  const { places, counts } = await new ProjectionService({
    refresh: async () => ({
      ...(await refreshAdapter(NOVOTEL_GOOGLE).refresh(
        googlePlace.providerIdentity,
      )),
      coordinates: { ...NOVOTEL_GOOGLE, crs: 'GCJ02' },
    }),
  }).project([googlePlace]);
  assert.deepEqual(places, []);
  assert.equal(counts.providerFailures, 1);
  assert.throws(
    () => wgs84Position({ ...NOVOTEL_GOOGLE, crs: 'GCJ02' }),
    /projection_non_wgs84_coordinates/,
  );
});

test('standardWgs84Position: only google-mainland inside mainland China moves', () => {
  near(
    standardWgs84Position(NOVOTEL_GOOGLE, 'google-mainland'),
    NOVOTEL_WGS84,
    'google-mainland',
  );
  assert.deepEqual(
    standardWgs84Position(NOVOTEL_GOOGLE, 'standard-wgs84'),
    NOVOTEL_GOOGLE,
  );
  for (const p of [STUTTGART, HONG_KONG, MACAU, TAIPEI])
    assert.deepEqual(standardWgs84Position(p, 'google-mainland'), p);
  assert.equal(
    isInMainlandChina(NOVOTEL_GOOGLE.latitude, NOVOTEL_GOOGLE.longitude),
    true,
  );
  for (const p of [HONG_KONG, MACAU, TAIPEI, STUTTGART])
    assert.equal(isInMainlandChina(p.latitude, p.longitude), false);
  assert.throws(
    () =>
      standardWgs84Position(
        { latitude: Number.NaN, longitude: 1 },
        'google-mainland',
      ),
    RangeError,
  );
});

test('the mainland region is the exact data Mom-I-am-OK carries', () => {
  // Both repositories pin the same digest of the region's data lines.
  const source = readFileSync(
    new URL(
      '../packages/core/src/mainland-china-region.generated.ts',
      import.meta.url,
    ),
    'utf8',
  );
  const data = source
    .split('\n')
    .filter((line) => line.startsWith('export const'))
    .join('\n');
  assert.equal(
    createHash('sha256').update(data).digest('hex'),
    REGION_DATA_SHA256,
  );
});
