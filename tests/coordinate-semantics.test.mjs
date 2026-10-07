// Coordinate semantics belong to the coordinate value an acquisition adapter produced, never to
// the provider name. The Places API location is WGS84 (GooglePlacesPoi states crs: 'WGS84'),
// stored OSM/Nominatim coordinates are WGS84, and every serializer emits WGS84 positions
// unchanged. Synthetic fixtures only; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ProjectionService,
  geojson,
  gpx,
  kml,
  wgs84Position,
} from '@places/core';
import { CoordinatesSchema } from '@places/schemas';
import { row, googleFixture } from './fixtures/google-places.mjs';

const time = '2026-01-01T00:00:00.000Z';
// A Shanghai pair (the numbers of the reported hotel), used only as a numeric fixture.
const SHANGHAI = { latitude: 31.2394719, longitude: 121.5248297 };

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
  label: 'Synthetic dumpling shop',
  labelSource: 'recognition',
  createdAt: time,
  updatedAt: time,
};
const osmPlace = {
  id: 'osm-place',
  workspaceId: 'fixture',
  canonicalName: 'Synthetic park',
  aliases: [],
  category: 'park',
  coordinates: { latitude: 31.23, longitude: 121.47, crs: 'WGS84' },
  address: { formatted: 'Synthetic OSM address' },
  source: { provider: 'nominatim', externalId: 'node:1', observedAt: time },
  evidence: [{ provider: 'nominatim', externalId: 'node:1', observedAt: time }],
  confidence: 0.9,
  status: 'confirmed',
  tags: [],
  createdAt: time,
  updatedAt: time,
};

// The real refresh adapter, fed a Places API response through a fetch double.
const refreshAdapter = () =>
  googleFixture(
    undefined,
    async () => new Response(JSON.stringify({ ...row, location: SHANGHAI })),
  );

test('Places API refresh states WGS84 for its location and projection propagates that coordinate value unchanged', async () => {
  const view = await refreshAdapter().refresh(googlePlace.providerIdentity);
  assert.deepEqual(view.coordinates, { ...SHANGHAI, crs: 'WGS84' });
  const { places } = await new ProjectionService(refreshAdapter()).project([
    googlePlace,
    osmPlace,
  ]);
  const google = places.find((p) => p.id === 'google-place');
  const osm = places.find((p) => p.id === 'osm-place');
  // Same numbers, same CRS: nothing is converted or re-labelled from the provider name.
  assert.deepEqual(google.coordinates, { ...SHANGHAI, crs: 'WGS84' });
  assert.deepEqual(osm.coordinates, osmPlace.coordinates);
  assert.equal('coordinateSystem' in google, false);
  assert.equal('coordinateSystem' in osm, false);
});

test('GeoJSON geometry is RFC 7946 WGS84, numerically unchanged, and no feature claims another system', async () => {
  const { places } = await new ProjectionService(refreshAdapter()).project([
    googlePlace,
    osmPlace,
  ]);
  const collection = geojson(places);
  assert.equal('crs' in collection, false, 'RFC 7946: no CRS member');
  assert.deepEqual(
    collection.features.map((f) => [f.id, f.geometry.coordinates]),
    [
      ['google-place', [SHANGHAI.longitude, SHANGHAI.latitude]],
      ['osm-place', [121.47, 31.23]],
    ],
  );
  for (const feature of collection.features) {
    assert.equal('coordinateSystem' in feature.properties, false);
    assert.equal(JSON.stringify(feature).toLowerCase().includes('gcj'), false);
  }
});

test('GPX and KML carry the same WGS84 numbers', async () => {
  const { places } = await new ProjectionService(refreshAdapter()).project([
    googlePlace,
  ]);
  assert.match(
    gpx(places),
    new RegExp(`<wpt lat="${SHANGHAI.latitude}" lon="${SHANGHAI.longitude}">`),
  );
  assert.match(
    kml(places),
    new RegExp(
      `<coordinates>${SHANGHAI.longitude},${SHANGHAI.latitude}</coordinates>`,
    ),
  );
});

test('a coordinate that is not WGS84 can neither enter a projection nor be serialized', async () => {
  assert.equal(
    CoordinatesSchema.safeParse({ ...SHANGHAI, crs: 'GCJ02' }).success,
    false,
  );
  const { places, counts } = await new ProjectionService({
    refresh: async () => ({
      ...(await refreshAdapter().refresh(googlePlace.providerIdentity)),
      coordinates: { ...SHANGHAI, crs: 'GCJ02' },
    }),
  }).project([googlePlace]);
  assert.deepEqual(places, []);
  assert.equal(counts.providerFailures, 1);
  assert.throws(
    () => wgs84Position({ ...SHANGHAI, crs: 'GCJ02' }),
    /projection_non_wgs84_coordinates/,
  );
  assert.deepEqual(wgs84Position({ ...SHANGHAI, crs: 'WGS84' }), SHANGHAI);
});
