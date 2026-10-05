import { assertGoogleAlternatives } from './fixtures/google-places.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { GooglePlacesPoi } from '@places/providers';
import { localityInAddress } from '../packages/providers/dist/google-places.js';
import {
  categorySupport,
  providerBaseName,
  venueNameEvidence,
} from '../packages/providers/dist/place-matching.js';
import { row, token, project } from './fixtures/google-places.mjs';
const recognition = {
  visibleText: ['PRIVATE_SIGN'],
  clues: [
    {
      name: 'Grande Alimentari',
      aliases: [],
      category: 'unknown-venue',
      confidence: 0.98,
    },
  ],
};
const noEvidence = { status: 'no_evidence', candidates: [], references: [] };
const semantic = {
  ...noEvidence,
  localityIntent: {
    input: 'шанхай',
    canonicalName: 'Shanghai',
    aliases: ['上海', '上海市'],
    countryCode: 'CN',
    confidence: 0.98,
  },
};
const country = { longText: 'China', shortText: 'CN', types: ['country'] };
const partial = {
  ...row,
  displayName: { text: 'Alimentari Grande Riverside (Donghu Road Branch)' },
  types: ['point_of_interest', 'establishment'],
  formattedAddress: '18 Donghu Road, Shanghai, China',
  addressComponents: [
    country,
    { longText: 'Shanghai', types: ['administrative_area_level_1'] },
  ],
};
function provider(rows, events = [], requests = []) {
  return new GooglePlacesPoi(
    async () => token,
    project,
    async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return Response.json({ places: rows });
    },
    Date.now,
    (e) => events.push(e),
  );
}
for (const [name, type] of [
  ['Shanghai', 'administrative_area_level_1'],
  ['上海市', 'administrative_area_level_1'],
  ['Shanghai', 'administrative_area_level_2'],
  ['上海市', 'locality'],
])
  test(`real Alimentari partial accepts with ${type}=${name}, no category/address/web corroborator`, async () => {
    const events = [],
      requests = [];
    const result = await provider(
      [
        {
          ...partial,
          addressComponents: [country, { longText: name, types: [type] }],
        },
      ],
      events,
      requests,
    ).resolve(recognition, semantic, { cityOverride: 'шанхай' });
    assert.equal(result.status, 'resolved');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].languageCode, 'en');
    const e = events.find((e) => e.event === 'google_places_decision');
    assert.equal(e.nameEvidence, 'strong_partial');
    assert.equal(e.nameRankPermille, 720);
    assert.equal(e.localityState, 'match');
    assert.equal(e.countryState, 'match');
    assert.equal(e.addressState, 'absent');
    assert.equal(e.categoryState, 'unknown');
    assert.equal(e.decision, 'accepted_partial_with_locality');
    const counts = events.find((e) => e.event === 'google_places_filter');
    assert.equal(counts.cityCompatible, 1);
    assert.equal(counts.countryCompatible, 1);
    assert.equal('localityCompatible' in counts, false);
  });
for (const city of ['Shanghai', 'Beijing', 'Tianjin', 'Chongqing'])
  test(`English administrative municipality ${city} corroborates explicit city without a lookup table`, async () => {
    const result = await provider([
      {
        ...partial,
        formattedAddress: 'PRIVATE_ADDRESS',
        addressComponents: [
          country,
          { longText: city, types: ['administrative_area_level_1'] },
        ],
      },
    ]).firstPass(recognition, { cityOverride: city });
    assert.equal(result.status, 'resolved');
  });
test('Shenzhen matches a typed city or admin layer while Guangdong remains neutral', async () => {
  for (const type of ['locality', 'administrative_area_level_2']) {
    const result = await provider([
      {
        ...partial,
        addressComponents: [
          country,
          { longText: 'Guangdong', types: ['administrative_area_level_1'] },
          { longText: 'Shenzhen', types: [type] },
        ],
      },
    ]).firstPass(recognition, { cityOverride: 'Shenzhen' });
    assert.equal(result.status, 'resolved');
  }
});
test('formattedAddress safely corroborates city only when reliably typed city is unavailable', async () => {
  const events = [];
  const p = provider([{ ...partial, addressComponents: [country] }], events);
  assert.equal(
    (await p.resolve(recognition, semantic, { cityOverride: 'шанхай' })).status,
    'resolved',
  );
  assert.equal(
    events.find((e) => e.event === 'google_places_decision').decision,
    'accepted_partial_with_locality',
  );
  for (const [alias, address, matches] of [
    ['Shanghai', '18 Street, Shanghai, China', true],
    ['上海', '道路, 上海市, 中国', true],
    ['New York', 'Street, New York, USA', true],
    ['ham', 'Shanghai, China', false],
    ['York', 'Yorkshire, UK', false],
    ['Shanghai', 'Shanghaiish, China', false],
  ])
    assert.equal(localityInAddress(alias, address), matches);
  const wrong = {
    ...partial,
    addressComponents: [
      country,
      { longText: 'Guangzhou', types: ['locality'] },
    ],
  };
  const logs = [];
  assert.notEqual(
    (
      await provider([wrong], logs).firstPass(recognition, {
        cityOverride: 'Shanghai',
      })
    ).status,
    'resolved',
  );
  assert.equal(
    logs.find((e) => e.event === 'google_places_decision').decision,
    'rejected_hard_conflict',
  );
});
for (const [city, type] of [
  ['Shanghai', 'locality'],
  ['Shanghai', 'administrative_area_level_2'],
  ['上海市', 'administrative_area_level_1'],
])
  test(`explicit wrong city rejects reliably city-level ${type}=${city}`, async () => {
    const events = [];
    assert.notEqual(
      (
        await provider(
          [
            {
              ...partial,
              addressComponents: [country, { longText: city, types: [type] }],
            },
          ],
          events,
        ).firstPass(
          recognition,
          { cityOverride: 'Guangzhou' },
          {
            status: 'no_evidence',
            candidates: [],
            references: [],
            localityIntent: {
              input: 'Guangzhou',
              canonicalName: 'Guangzhou',
              aliases: ['广州'],
              confidence: 0.95,
            },
          },
        )
      ).status,
      'resolved',
    );
    assert.equal(
      events.find((e) => e.event === 'google_places_decision').decision,
      'rejected_hard_conflict',
    );
  });
test('country agreement never masquerades as city agreement; unique partial identity surfaces with low confidence', async () => {
  const events = [];
  const result = await provider(
    [
      {
        ...partial,
        formattedAddress: 'PRIVATE_ADDRESS',
        addressComponents: [country],
      },
    ],
    events,
  ).resolve(recognition, semantic, { cityOverride: 'шанхай' });
  assert.equal(result.status, 'resolved');
  assert.equal(result.candidate.candidateConfidence, 'low');
  const e = events.find((e) => e.event === 'google_places_filter');
  assert.equal(e.cityCompatible, 0);
  assert.equal(e.countryCompatible, 1);
});
test('provider branch qualifiers preserve strong base identity without stripping arbitrary parentheses', () => {
  for (const suffix of [
    ' (Donghu Road Branch)',
    '(东湖路店)',
    ' - Donghu Road Branch',
  ]) {
    assert.equal(
      providerBaseName('Alimentari Grande' + suffix),
      'Alimentari Grande',
    );
    assert.equal(
      venueNameEvidence('Grande Alimentari', 'Alimentari Grande' + suffix)
        .nameEvidence,
      'reordered',
    );
  }
  assert.equal(providerBaseName('Museum (Hotel)'), 'Museum (Hotel)');
  assert.notEqual(
    venueNameEvidence('Museum', 'Museum (Hotel)').nameEvidence,
    'exact',
  );
  assert.equal(
    providerBaseName('Alimentari (Airport)'),
    'Alimentari (Airport)',
  );
});
test('same-base branches never choose a city by provider ordering; city correction separates them', async () => {
  const a = {
    ...partial,
    displayName: { text: 'Alimentari Grande (Donghu Road Branch)' },
    addressComponents: [country, { longText: 'Shanghai', types: ['locality'] }],
  };
  const b = {
    ...a,
    id: 'guangzhou-branch',
    displayName: { text: 'Alimentari Grande(北京路店)' },
    formattedAddress: 'Guangzhou, China',
    addressComponents: [
      country,
      { longText: 'Guangzhou', types: ['locality'] },
    ],
  };
  for (const rows of [
    [a, b],
    [b, a],
  ]) {
    assertGoogleAlternatives(await provider(rows).firstPass(recognition));
    const events = [],
      requests = [];
    const resolved = await provider(rows, events, requests).resolve(
      recognition,
      semantic,
      { cityOverride: 'шанхай' },
    );
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.candidate.providerIdentity.id, a.id);
    assert.equal(requests.length, 1);
  }
});
for (const category of ['deli', 'grocery', 'food store', 'supermarket'])
  test(`symmetric food category ${category} supports Google food types; unknown stays neutral`, () => {
    for (const type of [
      'deli',
      'grocery_store',
      'food_store',
      'supermarket',
      'restaurant',
    ])
      assert.ok(
        ['related', 'compatible'].includes(categorySupport(category, [type])),
      );
    assert.equal(categorySupport('UNKNOWN_DOMAIN', ['deli']), 'unknown');
  });

for (const [
  scenario,
  cityOverride,
  components,
  formattedAddress,
  resolved,
  decision,
] of [
  [
    'unfamiliar English admin1 remains unknown for explicit Guangzhou',
    'Guangzhou',
    [country, { longText: 'Shanghai', types: ['administrative_area_level_1'] }],
    'Shanghai, China',
    true,
    'accepted_strong_identity',
  ],
  [
    'unknown cross-script administrative locality is neutral',
    'Guangzhou',
    [country, { longText: '上海市', types: ['administrative_area_level_1'] }],
    '上海市, 中国',
    true,
    'accepted_strong_identity',
  ],
  [
    'English Shanghai municipality corroborates Shanghai',
    'Shanghai',
    [country, { longText: 'Shanghai', types: ['administrative_area_level_1'] }],
    'PRIVATE_ADDRESS',
    true,
    'accepted_strong_identity',
  ],
  [
    'Guangdong stays neutral alongside Guangzhou locality',
    'Guangzhou',
    [
      country,
      { longText: 'Guangdong', types: ['administrative_area_level_1'] },
      { longText: 'Guangzhou', types: ['locality'] },
    ],
    'Guangzhou, Guangdong, China',
    true,
    'accepted_strong_identity',
  ],
  [
    'country alone leaves explicit Guangzhou unknown',
    'Guangzhou',
    [country],
    'China',
    true,
    'accepted_strong_identity',
  ],
  [
    'country-only unique identity can still resolve cityless',
    undefined,
    [country],
    'China',
    true,
    'accepted_strong_identity',
  ],
  [
    'formattedAddress corroborates Guangzhou when typed city is unavailable',
    'Guangzhou',
    [
      country,
      { longText: 'Guangdong', types: ['administrative_area_level_1'] },
    ],
    '18 Road, Guangzhou, China',
    true,
    'accepted_strong_identity',
  ],
])
  for (const returnedName of ['Grande Alimentari', 'Alimentari Grande'])
    test(`explicit locality constraint: ${scenario} / ${returnedName}`, async () => {
      const events = [];
      const strong = {
        ...partial,
        displayName: { text: returnedName },
        addressComponents: components,
        formattedAddress,
      };
      const result = await provider([strong], events).firstPass(
        recognition,
        cityOverride ? { cityOverride } : {},
      );
      assert.equal(result.status === 'resolved', resolved);
      const e = events.find((e) => e.event === 'google_places_decision');
      assert.equal(e.decision, decision);
      assert.equal(
        e.localityState,
        resolved &&
          cityOverride &&
          ![
            'unfamiliar English admin1 remains unknown for explicit Guangzhou',
            'country alone leaves explicit Guangzhou unknown',
            'unknown cross-script administrative locality is neutral',
          ].includes(scenario)
          ? 'match'
          : decision === 'rejected_hard_conflict'
            ? 'conflict'
            : 'unknown',
      );
    });
