import { assertGoogleAlternatives } from './fixtures/google-places.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GooglePlaceIdSchema,
  GoogleIdentitySchema,
  IdSchema,
  CandidateSchema,
  storedCandidate,
} from '@places/schemas';
import { GooglePlacesPoi, canonicalPlaceId } from '@places/providers';
import { renderAttribution } from '../apps/functions/dist/interactions.js';
import {
  adaptGoogleRow,
  searchEnvelope,
  GOOGLE_BODY_LIMIT,
} from '../packages/providers/dist/google-places-contract.js';
import {
  row,
  recognition,
  verification,
  token,
  project,
  googleFixture,
} from './fixtures/google-places.mjs';
const clone = structuredClone;
const resolve = (r) =>
  googleFixture({ places: [r] }).resolve(recognition, verification);
// Current Places API (New) response shape; public restaurant ID/name/address from the
// choose-fields example, extended with requested WGS84/AddressComponent fields.
// https://developers.google.com/maps/documentation/places/web-service/choose-fields
const documentedPlace = {
  name: 'places/ChIJs5ydyTiuEmsR0fRSlU0C7k0',
  id: 'ChIJs5ydyTiuEmsR0fRSlU0C7k0',
  displayName: { text: 'Spiced @ Barangaroo', languageCode: 'en' },
  formattedAddress: '29 King St, Sydney NSW 2000, Australia',
  location: { latitude: -33.8665, longitude: 151.201 },
  addressComponents: [
    {
      longText: 'Sydney',
      shortText: 'Sydney',
      types: ['locality', 'political'],
      languageCode: 'en',
    },
    { longText: 'Australia', shortText: 'AU', types: ['country', 'political'] },
    { longText: 'Lieu-dit', types: [] },
  ],
};
test('current documented DTO accepts empty component types and strips unknown nested/top-level data', () => {
  const adapted = adaptGoogleRow(
    {
      ...documentedPlace,
      futureObject: { private: token },
      displayName: { ...documentedPlace.displayName, future: true },
      location: { ...documentedPlace.location, future: true },
      addressComponents: [
        ...documentedPlace.addressComponents,
        { future: true },
      ],
    },
    token,
  );
  assert.equal(adapted.code, 'usable');
  assert.equal(adapted.row.addressComponents.at(-2).types.length, 0);
  assert.deepEqual(adapted.row.addressComponents.at(-1), { types: [] });
  for (const field of ['name', 'futureObject'])
    assert.equal(field in adapted.row, false);
  assert.deepEqual(adapted.row.displayName, { text: 'Spiced @ Barangaroo' });
  assert.equal(JSON.stringify(adapted.row).includes('future'), false);
});
for (const id of ['opaque /?é#ID:不透明', 'long-' + 'x'.repeat(8000)]) {
  test(`opaque Google ID stays separate from canonical document IDs (${id.length} characters)`, async () => {
    assert.equal(GooglePlaceIdSchema.parse(id), id);
    assert.equal(
      GoogleIdentitySchema.parse({ provider: 'google-places', id }).id,
      id,
    );
    assert.equal(IdSchema.safeParse(id).success, false);
    const result = await resolve({ ...row, id });
    assert.equal(result.status, 'resolved');
    const stored = storedCandidate(result.candidate);
    assert.equal(stored.providerIdentity.id, id);
    assert.match(canonicalPlaceId(result.candidate), /^[a-f0-9]{64}$/);
    assert.equal(
      canonicalPlaceId(result.candidate),
      canonicalPlaceId({ ...result.candidate, canonicalName: 'new spelling' }),
    );
    const refresh = googleFixture(undefined, async (url) => {
      assert.equal(
        url,
        'https://places.googleapis.com/v1/places/' + encodeURIComponent(id),
      );
      return Response.json({ ...row, id });
    });
    assert.equal(
      (await refresh.refresh(stored.providerIdentity)).providerIdentity.id,
      id,
    );
  });
}
test('no provider text/count/URI/token length guesses survive DTO parsing', () => {
  const long = 'x'.repeat(10001);
  const external = {
    ...row,
    id: long,
    displayName: { text: long },
    formattedAddress: long,
    types: Array(50).fill('future_type'),
    addressComponents: Array(40).fill({
      longText: long,
      types: Array(12).fill('future_component'),
    }),
    attributions: Array(20).fill({
      provider: long,
      providerUri: 'urn:example:' + long,
    }),
  };
  const result = adaptGoogleRow(external);
  assert.equal(result.code, 'usable');
  assert.equal(result.row.addressComponents.length, 40);
  assert.equal(result.row.attributions.length, 20);
  assert.equal(result.row.displayName.text, long);
  assert.equal(
    searchEnvelope({ places: [external], nextPageToken: long, future: true })
      .nextPageToken,
    long,
  );
});
test('complex long address and no-longer-guessed component/type limits do not prevent resolution', async () => {
  const longRow = {
    ...row,
    formattedAddress: row.formattedAddress + ', Complex Building '.repeat(400),
    types: [...row.types, ...Array(40).fill('future_type')],
    addressComponents: [
      ...row.addressComponents,
      ...Array(40).fill({
        longText: 'unclassified-' + 'x'.repeat(400),
        types: [],
      }),
    ],
  };
  assert.equal((await resolve(longRow)).status, 'resolved');
});
for (const [label, mutate] of [
  ['no components', (r) => delete r.addressComponents],
  [
    'no locality',
    (r) =>
      (r.addressComponents = r.addressComponents.filter(
        (c) => !c.types.includes('locality'),
      )),
  ],
  [
    'no country',
    (r) =>
      (r.addressComponents = r.addressComponents.filter(
        (c) => !c.types.includes('country'),
      )),
  ],
  ['no address', (r) => delete r.formattedAddress],
  ['no types', (r) => delete r.types],
  ['new type', (r) => (r.types = ['future_interesting_destination'])],
  [
    'multiple geographic layers',
    (r) =>
      r.addressComponents.push({
        longText: 'Other geographic layer',
        types: ['locality'],
      }),
  ],
  ['related restaurant', (r) => (r.types = ['restaurant', 'food'])],
  [
    'different postal hierarchy',
    (r) =>
      r.addressComponents.push({
        longText: 'Other mailing district',
        types: ['postal_town'],
      }),
  ],
  [
    'duplicate countries',
    (r) =>
      r.addressComponents.push({
        longText: 'China',
        shortText: 'CN',
        types: ['country'],
      }),
  ],
  [
    'unknown country metadata',
    (r) => r.addressComponents.push({ types: ['country'] }),
  ],
])
  test(`missing/neutral/related evidence stays usable: ${label}`, async () => {
    const changed = clone(row);
    mutate(changed);
    const result = await resolve(changed);
    assert.equal(result.status, 'resolved');
    if (label === 'new type' || label === 'no types')
      assert.equal(result.candidate.category, 'cafe');
  });
for (const [label, mutate] of [
  ['country', (r) => (r.addressComponents[3].shortText = 'JP')],
  [
    'canonical city',
    (r) =>
      (r.addressComponents[2].longText = r.addressComponents[2].shortText =
        'Guangzhou'),
  ],
  [
    'house number',
    (r) =>
      (r.addressComponents[0].longText = r.addressComponents[0].shortText =
        '180'),
  ],
])
  test(`explicit contrary evidence still prevents a match: ${label}`, async () => {
    const changed = clone(row);
    mutate(changed);
    assert.notEqual((await resolve(changed)).status, 'resolved');
  });
for (const number of [
  '18-20',
  '18/2',
  '18-A',
  '18 Apt 3',
  'Building A, 18',
  'Unit 3',
  '',
])
  test(`non-comparable range/building/subpremise evidence is neutral: ${number}`, async () => {
    const changed = clone(row);
    changed.formattedAddress = number + ' Fixture Road, Shanghai';
    changed.addressComponents[0].longText = number;
    changed.addressComponents[0].shortText = number;
    assert.equal((await resolve(changed)).status, 'resolved');
  });
test('one bad row does not poison siblings; adaptation diagnostics contain only fixed paths/counts', async () => {
  const events = [];
  const bad = [
    null,
    { ...row, id: undefined },
    { ...row, displayName: undefined },
    { ...row, location: undefined },
    { ...row, location: { latitude: '31.23', longitude: 121.45 } },
    { ...row, types: 42 },
  ];
  const provider = new GooglePlacesPoi(
    async () => token,
    project,
    async () =>
      Response.json({ places: [row, ...bad], future: { private: token } }),
    Date.now,
    (e) => events.push(e),
  );
  assert.equal(
    (await provider.resolve(recognition, verification)).status,
    'resolved',
  );
  const event = events.find((e) => e.event === 'google_places_parse');
  assert.deepEqual(event, {
    event: 'google_places_parse',
    topLevel: 'ok',
    rowsReturned: 7,
    rowsUsable: 1,
    rowsSkipped: 6,
    skipped: {
      missing_id: 1,
      missing_display_name: 1,
      missing_location: 1,
      invalid_location: 1,
      unsupported_shape: 2,
    },
  });
  const json = JSON.stringify(events);
  for (const privateValue of [
    token,
    row.id,
    row.displayName.text,
    row.formattedAddress,
    '31.23',
    '121.45',
    'Shanghai',
    row.attributions[0].provider,
  ])
    assert.equal(json.includes(privateValue), false);
});
for (const location of [
  { latitude: 91, longitude: 0 },
  { latitude: 0, longitude: -181 },
  { latitude: Infinity, longitude: 0 },
  { latitude: NaN, longitude: 0 },
  { latitude: '1', longitude: 0 },
  { longitude: 0 },
])
  test('malformed coordinates never enter an internal candidate', () => {
    assert.equal(adaptGoogleRow({ ...row, location }).code, 'invalid_location');
    assert.equal(
      CandidateSchema.safeParse({ coordinates: location }).success,
      false,
    );
  });
for (const uri of [
  'https://example.org/credit',
  'http://example.org/credit',
  'mailto:author@example.org',
  'urn:example:credit',
  'javascript:alert(1)',
  'not a URL',
])
  test(`provider URI validity is separate from rendering: ${uri}`, async () => {
    const result = await resolve({
      ...row,
      attributions: [{ provider: 'Credit\nProvider', providerUri: uri }],
    });
    assert.equal(result.status, 'resolved');
    assert.equal(result.candidate.attributions[0].providerUri, uri);
    const text = renderAttribution(result.candidate.attributions[0]);
    assert.match(text, /Credit Provider/);
    assert.equal(text.includes(uri), /^https?:/u.test(uri));
  });
test('next-page token has no invented maximum and prevents premature resolution', async () => {
  assert.equal(
    (
      await googleFixture({
        places: [{ ...row, addressComponents: undefined }],
        nextPageToken: 'x'.repeat(10001),
      }).resolve(recognition, verification)
    ).status,
    'resolved',
  );
  assert.equal(
    (
      await googleFixture({ places: [row], nextPageToken: '' }).resolve(
        recognition,
        verification,
      )
    ).status,
    'resolved',
  );
});
test('transport safeguard is separate from external contract validity and logs no raw body', async () => {
  assert.equal(GOOGLE_BODY_LIMIT, 8 * 1024 * 1024);
  assert.equal(
    (
      await googleFixture({
        places: [row],
        futurePadding: 'x'.repeat(250000),
      }).resolve(recognition, verification)
    ).status,
    'resolved',
  );
  for (const [body, path, code] of [
    ['{PRIVATE_BODY', 'invalid_json', 'google_places_invalid_json'],
    [
      JSON.stringify({ places: 42 }),
      'top_level_invalid',
      'google_places_top_level_invalid',
    ],
    [
      'x'.repeat(GOOGLE_BODY_LIMIT + 1),
      'response_too_large',
      'google_places_response_too_large',
    ],
  ]) {
    const events = [];
    const provider = new GooglePlacesPoi(
      async () => token,
      project,
      async () => new Response(body),
      Date.now,
      (e) => events.push(e),
    );
    await assert.rejects(provider.resolve(recognition, verification), {
      message: code,
    });
    assert.equal(
      events.find((e) => e.event === 'google_places_parse').topLevel,
      path,
    );
    assert.equal(JSON.stringify(events).includes('PRIVATE_BODY'), false);
  }
});

test('opaque IDs remain schema-valid but impossible URL adaptation fails safely before any refresh request', async () => {
  for (const id of ['.', '..', '\ud800']) {
    assert.equal(GooglePlaceIdSchema.safeParse(id).success, true);
    await assert.rejects(
      googleFixture(undefined, async () =>
        assert.fail('must not request a normalized parent path'),
      ).refresh({ provider: 'google-places', id }),
      { message: 'google_places_adaptation_failed' },
    );
  }
});
