import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RecognitionSchema,
  MAX_RECOMMENDATIONS,
  MAX_SEARCH_BRANDS,
  storedCandidate,
  recommendationSearchCity,
  GeographicContextSchema,
} from '@places/schemas';
import {
  GooglePlacesPoi,
  GooglePlacesFailure,
  GeminiVision,
  visionInstructions,
} from '@places/providers';
import { googleSearchPlan } from '../packages/providers/dist/google-search-plan.js';
const empty = { status: 'no_evidence', candidates: [], references: [] };
const names = ['Cedar Gallery', 'Кедровый Дом', '風鈴堂', 'AX'];
const list = (brands = names) =>
  RecognitionSchema.parse({
    mode: 'recommendation_list',
    visibleText: ['PRIVATE_USERNAME', 'INTERFACE_LABEL', 'PRIVATE_MESSAGE'],
    clues: brands.map((name) => ({
      name,
      aliases: [],
      category: 'museum',
      confidence: 0.95,
      recommendationEvidence: 'numbered_list',
    })),
  });
const row = (id, name, city = 'Vesper', country = 'FR') => ({
  id,
  displayName: { text: name },
  location: { latitude: 1, longitude: 2 },
  types: ['museum'],
  formattedAddress: `20 Test Road, ${city}`,
  addressComponents: [
    { longText: city, types: ['locality'] },
    { longText: 'Country', shortText: country, types: ['country'] },
  ],
  attributions: [{ provider: 'Synthetic Credit' }],
});
function fixture(fn) {
  const queries = [],
    events = [];
  const poi = new GooglePlacesPoi(
    async () => 'fixture-token',
    'fixture-project',
    async (url, init) => {
      assert.ok(String(url).endsWith(':searchText'), 'only Text Search');
      const body = JSON.parse(init.body);
      queries.push(body.textQuery);
      return fn(body.textQuery, queries.length);
    },
    Date.now,
    (e) => events.push(e),
  );
  return { poi, queries, events };
}
const context = { cityOverride: 'Vesper', selectedBrandIndices: [0, 1, 2, 3] };
test('Vision contract supports four independent public list entries across scripts, separate from photographed signage', async () => {
  const r = list();
  assert.deepEqual(
    r.clues.map((c) => c.name),
    names,
  );
  assert.equal(r.clues.length, 4);
  assert.equal(MAX_RECOMMENDATIONS, 8);
  assert.match(visionInstructions, /recommendation_list/);
  assert.match(visionInstructions, /EIGHT distinct/);
  assert.match(
    visionInstructions,
    /Exclude usernames, UI labels, unrelated comments, private messages/,
  );
  assert.match(
    visionInstructions,
    /list evidence is separate from physical signage/,
  );
  const original = globalThis.fetch;
  let prompt;
  globalThis.fetch = async (_url, init) => {
    prompt = JSON.parse(init.body).systemInstruction.parts[0].text;
    return Response.json({
      candidates: [
        {
          finishReason: 'STOP',
          content: { parts: [{ text: JSON.stringify(r) }] },
        },
      ],
    });
  };
  try {
    const output = await new GeminiVision(
      'fixture-key',
      'fixture-model',
    ).recognize([{ mimeType: 'image/png', bytes: new Uint8Array([1]) }]);
    assert.deepEqual(output.recognition, r);
    assert.equal(prompt, visionInstructions);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(
    RecognitionSchema.safeParse({
      ...r,
      clues: r.clues.map((c) => ({ ...c, signage: c.name })),
    }).success,
    false,
  );
  assert.equal(
    RecognitionSchema.safeParse({
      ...r,
      clues: r.clues.map(({ recommendationEvidence, ...c }) => c),
    }).success,
    false,
  );
  assert.equal(RecognitionSchema.safeParse(list()).success, true);
  assert.equal(
    RecognitionSchema.safeParse({ ...r, clues: [...r.clues, r.clues[0]] })
      .success,
    false,
  );
});
test('four brands receive four independent city-scoped queries; private/unrelated OCR never participates', async () => {
  const f = fixture((q) =>
    Response.json({ places: [row(q.split(',')[0], q.split(',')[0])] }),
  );
  const r = list();
  assert.deepEqual(
    googleSearchPlan(r, empty, context).queries,
    names.map((n) => `${n}, Vesper`),
  );
  const attempt = f.poi.beginAttempt();
  const result = await attempt.firstPass(r, context);
  assert.equal(result.status, 'alternatives');
  assert.equal(result.candidates.length, 4);
  assert.deepEqual(
    f.queries,
    names.map((n) => `${n}, Vesper`),
  );
  assert.deepEqual(
    result.candidates.map((c) => c.recognitionClueIndex),
    [0, 1, 2, 3],
  );
  assert.ok(!JSON.stringify(f.queries).match(/PRIVATE|INTERFACE/));
  await attempt.resolve(r, empty, context);
  assert.equal(
    f.queries.length,
    4,
    'enrichment cannot spend a second budget on lists',
  );
});
test('zero-result brand and unrelated sibling rows do not discard or misclassify successful siblings', async () => {
  const f = fixture((q) =>
    Response.json({
      places: q.startsWith(names[1])
        ? []
        : [
            row(q.split(',')[0], q.split(',')[0]),
            row('unrelated', 'Private UI Venue'),
            ...(q.startsWith(names[0]) ? [row('sibling', names[2])] : []),
          ],
    }),
  );
  const result = await f.poi.firstPass(list(), context);
  assert.deepEqual(
    result.candidates.map((c) => c.recognitionClueIndex),
    [0, 2, 3],
  );
  assert.ok(
    result.candidates.every((c) => !c.relationship.startsWith('related_')),
  );
  assert.equal(
    f.events.find(
      (e) => e.event === 'recommendation_brand_search' && e.brandSlot === 2,
    ).outcome,
    'empty_response',
  );
});
test('transient failure is isolated per brand; auth and parser/adaptation failures remain visible', async () => {
  const f = fixture((q) =>
    q.startsWith(names[1])
      ? new Response('', { status: 503 })
      : Response.json({ places: [row(q.split(',')[0], q.split(',')[0])] }),
  );
  const result = await f.poi.firstPass(list(), context);
  assert.equal(result.candidates.length, 3);
  assert.equal(
    f.events.find(
      (e) => e.event === 'recommendation_brand_search' && e.brandSlot === 2,
    ).outcome,
    'transient_failure',
  );
  for (const bad of [
    () => new Response('', { status: 403 }),
    () => Response.json({ places: 'broken' }),
  ]) {
    const broken = fixture((q) =>
      q.startsWith(names[1])
        ? bad()
        : Response.json({ places: [row('success', names[0])] }),
    );
    await assert.rejects(
      broken.poi.firstPass(list(), context),
      GooglePlacesFailure,
    );
  }
  await assert.rejects(
    fixture(() => new Response('', { status: 503 })).poi.firstPass(
      list(),
      context,
    ),
    /google_places_transient_failure/,
  );
});
test('branches stay individually selectable by Place ID, with fair eight-place allocation across five selected brands', async () => {
  const brands = [
    'Cedar Gallery',
    'Maple Gallery',
    'Willow Hall',
    'Birch Hall',
    'Hazel Gallery',
  ];
  const f = fixture((q) =>
    Response.json({
      places: Array.from({ length: 10 }, (_, i) =>
        row(
          `${q.split(',')[0]}-${i}`,
          `${q.split(',')[0]} (Section ${i} branch)`,
        ),
      ),
    }),
  );
  const result = await f.poi.firstPass(list(brands), {
    cityOverride: 'Vesper',
    selectedBrandIndices: [0, 1, 2, 3, 4],
  });
  assert.equal(f.queries.length, MAX_SEARCH_BRANDS);
  assert.equal(result.candidates.length, 8);
  assert.equal(
    new Set(result.candidates.map((c) => c.providerIdentity.id)).size,
    8,
  );
  assert.deepEqual(
    [...new Set(result.candidates.map((c) => c.recognitionClueIndex))],
    [0, 1, 2, 3, 4],
  );
  assert.equal(
    f.events.filter((e) => e.event === 'recommendation_brand_search').length,
    5,
  );
  assert.ok(
    f.events
      .filter((e) => e.event === 'recommendation_brand_search')
      .every((e) => e.eligible === 10 && e.queriesAllocated === 1),
  );
  for (const c of result.candidates)
    for (const key of [
      'canonicalName',
      'address',
      'coordinates',
      'attributions',
      'category',
    ])
      assert.equal(key in storedCandidate(c), false);
});
test('duplicates dedupe by provider ID; similar names never merge distinct locations', async () => {
  const f = fixture((q) =>
    Response.json({
      places: [
        row('one', q.split(',')[0]),
        row('one', q.split(',')[0]),
        row('two', q.split(',')[0]),
      ],
    }),
  );
  const result = await f.poi.firstPass(list([names[0]]), {
    cityOverride: 'Vesper',
    selectedBrandIndices: [0],
  });
  assert.deepEqual(
    result.candidates.map((c) => c.providerIdentity.id),
    ['one', 'two'],
  );
});
test('short exact brands survive; weak short tokens and unrelated names never become eligible', async () => {
  const f = fixture(() =>
    Response.json({
      places: [
        row('exact', 'AX'),
        row('branch', 'AX (North branch)'),
        row('weak', 'AX Unrelated Hall'),
        row('other', 'AXIS Gallery'),
      ],
    }),
  );
  const result = await f.poi.firstPass(list(['AX']), {
    cityOverride: 'Vesper',
    selectedBrandIndices: [0],
  });
  assert.deepEqual(
    result.candidates.map((c) => c.providerIdentity.id),
    ['exact', 'branch'],
  );
});
test('city normalization constrains every selected brand; reliable city/country contradictions block', async () => {
  const f = fixture((q) =>
    Response.json({
      places: [
        row('ok' + q, q.split(',')[0]),
        row('city' + q, q.split(',')[0], 'Other City'),
        row('country' + q, q.split(',')[0], 'Vesper', 'DE'),
      ],
    }),
  );
  const c = { ...context, cityOverride: 'Веспер' };
  const v = {
    ...empty,
    localityIntent: {
      input: 'Веспер',
      canonicalName: 'Vesper',
      aliases: ['Веспер'],
      countryCode: 'FR',
      confidence: 1,
    },
  };
  const result = await f.poi.firstPass(list(), c, v);
  assert.deepEqual(
    f.queries,
    names.map((n) => `${n}, Vesper, FR`),
  );
  assert.equal(result.candidates.length, 4);
  assert.ok(
    result.candidates.every(
      (c) => c.address.city === 'Vesper' && c.address.countryCode === 'FR',
    ),
  );
});
test('verified same-brand address contradiction cannot be hidden by the recognition comparison', async () => {
  const f = fixture(() =>
    Response.json({ places: [row('wrong-number', names[0])] }),
  );
  const v = {
    status: 'verified',
    candidates: [
      {
        canonicalName: names[0],
        aliases: [],
        cityAliases: [],
        category: 'museum',
        city: 'Vesper',
        addressClue: '99 Test Road',
        confidence: 1,
      },
    ],
    references: [
      {
        provider: 'web',
        url: 'https://example.org',
        observedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  };
  const result = await f.poi.resolve(list([names[0]]), v, {
    cityOverride: 'Vesper',
    selectedBrandIndices: [0],
  });
  assert.equal(result.status, 'unresolved');
  assert.equal(
    f.events.find((e) => e.event === 'recommendation_brand_search').outcome,
    'geographic_conflict',
  );
});
test('list searches require explicit selection and locality; excessive/invalid selections fail closed', async () => {
  const f = fixture(() => assert.fail('no provider query'));
  assert.equal(
    (await f.poi.firstPass(list(), { selectedBrandIndices: [0] })).status,
    'city_unknown',
  );
  for (const indices of [[], [0, 0], [9], [0, 1, 2, 3, 4, 5]])
    await assert.rejects(
      f.poi.firstPass(list(), {
        cityOverride: 'Vesper',
        selectedBrandIndices: indices,
      }),
      /google_places_request_failed/,
    );
});
test('recommendation telemetry contains only counts, fixed outcomes and ordinal slots', async () => {
  const f = fixture((q) =>
    Response.json({ places: [row(q.split(',')[0], q.split(',')[0])] }),
  );
  await f.poi.firstPass(list(), context);
  const events = f.events.filter(
    (e) => e.event === 'recommendation_brand_search',
  );
  assert.equal(events.length, 4);
  for (const e of events) {
    assert.deepEqual(
      Object.keys(e).sort(),
      [
        'brandSlot',
        'displayed',
        'eligible',
        'event',
        'outcome',
        'queriesAllocated',
      ].sort(),
    );
    assert.equal(e.outcome, 'results');
    assert.equal(e.eligible, 1);
    assert.equal(e.displayed, 1);
  }
  const text = JSON.stringify(f.events);
  for (const value of [
    ...names,
    'Vesper',
    'PRIVATE_USERNAME',
    'fixture-token',
    '20 Test Road',
  ])
    assert.equal(text.includes(value), false);
});
test('user-requested related locations remain potential after successful web enrichment with no chain evidence', async () => {
  let ordinary = 0;
  const f = fixture((q) => {
    if (q.includes('locations'))
      return Response.json({
        places: [
          row('seed', 'Cedar Gallery'),
          row('other', 'Cedar Gallery (North branch)'),
        ],
      });
    ordinary++;
    return Response.json({
      places:
        ordinary === 1
          ? [row('seed', 'Cedar Gallery')]
          : [
              row('seed', 'Cedar Gallery'),
              row('other', 'Cedar Gallery (North branch)'),
            ],
    });
  });
  const r = {
    mode: 'single_venue',
    visibleText: [],
    clues: [
      {
        name: 'Cedar Gallery',
        signage: 'Cedar Gallery',
        aliases: [],
        category: 'museum',
        confidence: 1,
      },
    ],
  };
  const c = { cityOverride: 'Vesper', relatedRequested: true };
  const attempt = f.poi.beginAttempt();
  const first = await attempt.firstPass(r, c);
  assert.equal(first.status, 'alternatives');
  const enriched = await attempt.resolve(
    r,
    {
      status: 'verified',
      candidates: [
        {
          canonicalName: 'Cedar Gallery',
          aliases: [],
          city: 'Vesper',
          cityAliases: [],
          category: 'museum',
          confidence: 1,
        },
      ],
      references: [
        {
          provider: 'web',
          url: 'https://example.org',
          observedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    },
    c,
  );
  assert.equal(
    enriched.candidates.find((c) => c.providerIdentity.id === 'other')
      .relationship,
    'related_chain_location',
  );
  assert.equal(
    enriched.candidates.find((c) => c.providerIdentity.id === 'other')
      .candidateConfidence,
    'low',
  );
  assert.ok(f.queries.length <= 5);
});
test('a reliable contradiction for a repeated ID cannot be rescued by another selected brand response', async () => {
  const f = fixture((q) =>
    Response.json({
      places: q.startsWith(names[0])
        ? [row('shared', names[0]), row('safe', names[0])]
        : [row('shared', names[1], 'Other City')],
    }),
  );
  const result = await f.poi.firstPass(list(names.slice(0, 2)), {
    cityOverride: 'Vesper',
    selectedBrandIndices: [0, 1],
  });
  assert.deepEqual(
    result.candidates.map((c) => c.providerIdentity.id),
    ['safe'],
  );
});

// Da Hu Chun (大壶春), 136 Sichuan Middle Road, Huangpu District, Shanghai: an Instagram list
// that names Shanghai. Synthetic copy of the shape only; no real message or image.
const daHuChun = (extra = [], hints = { cityHint: 'Shanghai' }) =>
  RecognitionSchema.parse({
    mode: 'recommendation_list',
    visibleText: [],
    clues: [
      {
        name: 'Da Hu Chun',
        nativeName: '大壶春',
        aliases: [],
        category: 'restaurant',
        confidence: 0.95,
        recommendationEvidence: 'caption',
        areaHint: 'Huangpu District',
        ...hints,
      },
      ...extra.map((clue) => ({
        aliases: [],
        category: 'restaurant',
        confidence: 0.95,
        recommendationEvidence: 'caption',
        ...clue,
      })),
    ],
  });
test('recommendation city: the selected clues alone decide, and only one shared cityHint counts', () => {
  assert.equal(recommendationSearchCity(daHuChun(), [0]), 'Shanghai');
  const same = daHuChun([{ name: 'Lao Zheng Xing', cityHint: 'shanghai' }]);
  assert.equal(recommendationSearchCity(same, [0, 1]), 'Shanghai');
  const other = daHuChun([{ name: 'Siji Minfu', cityHint: 'Beijing' }]);
  assert.equal(recommendationSearchCity(other, [0, 1]), undefined);
  assert.equal(recommendationSearchCity(other, [0]), 'Shanghai');
  assert.equal(recommendationSearchCity(other, [1]), 'Beijing');
  const unhinted = daHuChun([{ name: 'Jia Jia Tang Bao' }]);
  assert.equal(recommendationSearchCity(unhinted, [0, 1]), undefined);
  assert.equal(recommendationSearchCity(unhinted, [1]), undefined);
  // areaHint is a search hint, never a city.
  assert.equal(
    recommendationSearchCity(
      daHuChun([], { areaHint: 'Huangpu District' }),
      [0],
    ),
    undefined,
  );
  // Unselected, empty, out-of-range or non-list input decides nothing.
  assert.equal(recommendationSearchCity(daHuChun(), []), undefined);
  assert.equal(recommendationSearchCity(daHuChun(), undefined), undefined);
  assert.equal(recommendationSearchCity(daHuChun(), [5]), undefined);
  assert.equal(
    recommendationSearchCity(
      RecognitionSchema.parse({
        visibleText: [],
        clues: [
          {
            name: 'Da Hu Chun',
            aliases: [],
            category: 'restaurant',
            cityHint: 'Shanghai',
            confidence: 0.95,
          },
        ],
      }),
      [0],
    ),
    undefined,
  );
  // A hint listing alternatives or a low-confidence clue is not a city.
  assert.equal(
    recommendationSearchCity(
      daHuChun([], { cityHint: 'Shanghai / Suzhou' }),
      [0],
    ),
    undefined,
  );
  const weak = RecognitionSchema.parse({
    ...daHuChun(),
    clues: [{ ...daHuChun().clues[0], confidence: 0.6 }],
  });
  assert.equal(recommendationSearchCity(weak, [0]), undefined);
  // Legacy Recognition documents without cityHint stay valid and ask.
  assert.equal(recommendationSearchCity(list(), [0, 1]), undefined);
});
test('recommendation city: the inferred city scopes the search plan as vision evidence; a typed city wins', () => {
  const r = daHuChun();
  const inferred = googleSearchPlan(
    r,
    empty,
    GeographicContextSchema.parse({
      inferredCity: 'Shanghai',
      selectedBrandIndices: [0],
    }),
  );
  assert.deepEqual(inferred.queries, ['大壶春, Shanghai']);
  assert.equal(inferred.locality.source, 'vision');
  const typed = googleSearchPlan(
    r,
    empty,
    GeographicContextSchema.parse({
      cityOverride: 'Hangzhou',
      inferredCity: 'Shanghai',
      selectedBrandIndices: [0],
    }),
  );
  assert.deepEqual(typed.queries, ['大壶春, Hangzhou']);
  assert.equal(typed.locality.source, 'explicit');
  assert.ok(!typed.locality.aliases.includes('Shanghai'));
});
