import test from 'node:test';
import assert from 'node:assert/strict';
import { GooglePlacesPoi, visionInstructions } from '@places/providers';
import { storedCandidate } from '@places/schemas';
import { googleSearchPlan } from '../packages/providers/dist/google-search-plan.js';
const noEvidence = { status: 'no_evidence', candidates: [], references: [] };
const recognition = {
  visibleText: ['PRIVATE_OCR'],
  clues: [
    {
      name: 'Junipera',
      signage: 'GRAND JUNIPERA',
      possibleChain: 'Junipera',
      aliases: ['Speculative Alias'],
      category: 'museum',
      confidence: 0.6,
    },
  ],
};
const row = (
  id = 'seed',
  name = 'Junipera Riverside',
  components = [
    { longText: 'Territory', types: ['administrative_area_level_1'] },
  ],
  address = '1 Oak Road, Vesper',
) => ({
  id,
  displayName: { text: name },
  types: ['museum'],
  location: { latitude: 1, longitude: 2 },
  formattedAddress: address,
  addressComponents: [
    { longText: 'Country', shortText: 'FR', types: ['country'] },
    ...components,
  ],
});
function fixture(
  seed,
  branch = row('branch', 'Junipera Harbor Riverside', [
    { longText: 'Vesper', types: ['locality'] },
  ]),
) {
  const requests = [],
    events = [];
  const poi = new GooglePlacesPoi(
    async () => 'PRIVATE_TOKEN',
    'fixture-project',
    async (_url, init) => {
      if (init.method === 'GET') return Response.json(seed);
      const request = JSON.parse(init.body);
      requests.push(request);
      return Response.json({
        places: request.textQuery.includes(' locations, ')
          ? [branch]
          : seed
            ? [seed]
            : [],
      });
    },
    Date.now,
    (event) => events.push(event),
  );
  return { poi, requests, events };
}
const normalized = (input, city = 'Vesper', aliases = [input]) => ({
  ...noEvidence,
  localityIntent: {
    input,
    canonicalName: city,
    aliases,
    countryCode: 'FR',
    confidence: 0.95,
  },
});
for (const [input, city] of [
  ['vesper', 'Vesper'],
  ['Веспер', 'Vesper'],
  ['青庭', 'Qing Ting'],
])
  test(`normalized ${input} permits explicit-city chain lookup with unknown provider locality, never provider-region drift`, async () => {
    const f = fixture(
      row(
        'seed',
        'Junipera Riverside',
        [
          {
            longText: 'Unverified Territory',
            types: ['administrative_area_level_1'],
          },
        ],
        `1 Oak Road, ${city}`,
      ),
      row('branch', 'Junipera Harbor Riverside', [
        { longText: city, types: ['locality'] },
      ]),
    );
    const attempt = f.poi.beginAttempt(),
      v = normalized(input, city);
    const first = await attempt.firstPass(
      recognition,
      { cityOverride: input },
      v,
    );
    assert.equal(first.status, 'alternatives');
    assert.deepEqual(
      first.candidates.map((c) => c.providerIdentity.id),
      ['seed', 'branch'],
    );
    assert.equal(first.candidates[0].relationship, 'plausible_exact');
    assert.equal(first.candidates[0].address.city, undefined);
    assert.equal(
      first.candidates[0].address.providerContext,
      'Unverified Territory',
    );
    const initial = f.events.find((e) => e.event === 'google_places_candidate');
    assert.equal(initial.localityState, 'unknown');
    assert.equal(initial.localityEvidence, 'address_context');
    const enriched = await attempt.resolve(recognition, v, {
      cityOverride: input,
    });
    assert.equal(enriched.status, 'alternatives');
    assert.ok(f.requests.length <= 5);
    const related = f.requests.filter((q) =>
      q.textQuery.includes(' locations, '),
    );
    assert.equal(related.length, 1);
    assert.equal(related[0].textQuery, `Junipera locations, ${city}`);
    assert.equal(related[0].regionCode, 'FR');
    assert.ok(
      f.events.some(
        (e) =>
          e.event === 'google_related_expansion' &&
          e.reason === 'expanded' &&
          e.scope === 'explicit_normalized',
      ),
    );
    for (const candidate of first.candidates)
      assert.equal('address' in storedCandidate(candidate), false);
    assert.doesNotMatch(
      JSON.stringify(f.events),
      /Junipera|Vesper|Веспер|青庭|Qing Ting|Unverified Territory|PRIVATE_TOKEN|PRIVATE_OCR|Oak Road/u,
    );
  });
for (const [input, intent] of [
  ['Веспер', undefined],
  ['青庭', undefined],
  ['Веспер', { ...normalized('other').localityIntent }],
  ['Веспер', { ...normalized('Веспер').localityIntent, confidence: 0.2 }],
])
  test(`uncorroborated explicit ${input} with absent/stale/low normalization never expands into a provider city`, async () => {
    const f = fixture(
      row(
        'seed',
        'Junipera Riverside',
        [{ longText: 'Other City', types: ['locality'] }],
        '1 Oak Road, Other City',
      ),
    );
    const result = await f.poi.firstPass(
      recognition,
      { cityOverride: input },
      { ...noEvidence, ...(intent ? { localityIntent: intent } : {}) },
    );
    assert.equal(result.status, 'resolved');
    assert.equal(result.candidate.address.city, 'Other City');
    assert.equal(
      f.requests.some((q) => q.textQuery.includes(' locations, ')),
      false,
    );
    assert.ok(
      f.events.some(
        (e) =>
          e.event === 'google_related_expansion' &&
          e.reason === 'locality_unknown',
      ),
    );
  });
for (const [type, text, input] of [
  ['locality', 'Ve Sper', 'vesper'],
  ['postal_town', 'Ве спер', 'Веспер'],
  ['administrative_area_level_1', '青 庭', '青庭'],
  ['administrative_area_level_2', 'Ve Sper', 'Веспер'],
])
  test(`typed ${type} ${text} supports separator-normalized locality and display without address inference`, async () => {
    const f = fixture(
      row(
        'seed',
        'Junipera Riverside',
        [{ longText: text, types: [type] }],
        'PRIVATE_ADDRESS',
      ),
    );
    const first = await f.poi.firstPass(
      {
        ...recognition,
        clues: [{ ...recognition.clues[0], possibleChain: undefined }],
      },
      { cityOverride: input },
      normalized(input, input === 'Веспер' ? 'Vesper' : input),
    );
    assert.equal(first.status, 'resolved');
    assert.equal(first.candidate.address.city, text);
    const event = f.events.find((e) => e.event === 'google_places_candidate');
    assert.equal(event.localityState, 'match');
    assert.equal(event.localityEvidence, 'structured');
    const refreshed = await f.poi.refresh(first.candidate.providerIdentity);
    if (type === 'locality' || type === 'postal_town')
      assert.equal(refreshed.address.city, text);
    else {
      assert.equal(refreshed.address.city, undefined);
      assert.equal(refreshed.address.providerContext, text);
    }
  });
for (const conflict of ['city', 'country', 'address'])
  test(`reliable ${conflict} contradiction blocks normalized-city related discovery`, async () => {
    let seed = row('seed', 'Junipera Riverside', [
      {
        longText: conflict === 'city' ? 'Other City' : 'Vesper',
        types: ['locality'],
      },
    ]);
    if (conflict === 'country') seed.addressComponents[0].shortText = 'DE';
    if (conflict === 'address') seed.formattedAddress = '999 Oak Road, Vesper';
    const f = fixture(seed),
      v = normalized('Веспер');
    if (conflict === 'address')
      Object.assign(v, {
        status: 'verified',
        candidates: [
          {
            canonicalName: 'Junipera Riverside',
            aliases: [],
            cityAliases: [],
            category: 'museum',
            confidence: 0.9,
            addressClue: '158 Oak Road',
          },
        ],
        references: [
          {
            provider: 'web',
            url: 'https://example.org',
            observedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      });
    const result = await f.poi.firstPass(
      recognition,
      { cityOverride: 'Веспер' },
      v,
    );
    assert.equal(result.status, 'unresolved');
    assert.equal(
      f.requests.some((q) => q.textQuery.includes(' locations, ')),
      false,
    );
    assert.ok(
      f.events.some(
        (e) =>
          e.event === 'google_related_expansion' &&
          e.reason === 'conflicting_locality',
      ),
    );
  });
for (const chain of [undefined, 'Museum'])
  test(`absent/generic structured chain evidence is not fabricated (${chain})`, async () => {
    const f = fixture(row());
    await f.poi.firstPass(
      {
        ...recognition,
        clues: [{ ...recognition.clues[0], possibleChain: chain }],
      },
      { cityOverride: 'Веспер' },
      normalized('Веспер'),
    );
    assert.equal(
      f.requests.some((q) => q.textQuery.includes(' locations, ')),
      false,
    );
    assert.ok(
      f.events.some(
        (e) =>
          e.event === 'google_related_expansion' &&
          e.reason === 'no_chain_evidence' &&
          e.possibleChainPresent === !!chain &&
          e.signagePresent,
      ),
    );
    assert.match(visionInstructions, /Assess possibleChain explicitly/u);
  });
test('no explicit city requires a reliable chain seed city; administrative display-only context cannot scope discovery', async () => {
  const f = fixture(row());
  await f.poi.firstPass(recognition);
  assert.equal(
    f.requests.some((q) => q.textQuery.includes(' locations, ')),
    false,
  );
  assert.ok(
    f.events.some(
      (e) =>
        e.event === 'google_related_expansion' &&
        e.reason === 'provider_city_unavailable',
    ),
  );
  const g = fixture(
    row('seed', 'Junipera Riverside', [
      { longText: 'Vesper', types: ['locality'] },
    ]),
  );
  await g.poi.firstPass(recognition);
  assert.equal(
    g.requests.filter((q) => q.textQuery.includes(' locations, ')).length,
    1,
  );
  assert.ok(
    g.events.some(
      (e) =>
        e.event === 'google_related_expansion' &&
        e.reason === 'expanded' &&
        e.scope === 'provider',
    ),
  );
});
test('cityless primary signage receives an unscoped existing query slot despite stale weak area hints; empty rows remain observable', async () => {
  const r = {
    ...recognition,
    clues: [{ ...recognition.clues[0], areaHint: 'Wrong Territory' }],
  };
  const plan = googleSearchPlan(r, noEvidence, {
    workspaceAreaHint: 'Stale Workspace',
  });
  assert.equal(plan.queries.length, 2);
  assert.equal(plan.queries[1], 'GRAND JUNIPERA');
  assert.equal(plan.unscopedQueryPlanned, true);
  assert.doesNotMatch(
    JSON.stringify(plan.queries),
    /PRIVATE_OCR|Speculative Alias/u,
  );
  const f = fixture(undefined),
    attempt = f.poi.beginAttempt();
  await attempt.firstPass(r, { workspaceAreaHint: 'Stale Workspace' });
  await attempt.resolve(r, noEvidence, {
    workspaceAreaHint: 'Stale Workspace',
  });
  assert.equal(f.requests.length, 4);
  assert.ok(
    f.events
      .filter((e) => e.event === 'place_search_plan')
      .every(
        (e) =>
          e.signagePresent && e.possibleChainPresent && e.unscopedQueryPlanned,
      ),
  );
  assert.ok(
    f.events.some(
      (e) =>
        e.event === 'google_related_expansion' &&
        e.reason === 'no_eligible_seed',
    ),
  );
  assert.doesNotMatch(
    JSON.stringify(f.events),
    /GRAND JUNIPERA|Wrong Territory|Stale Workspace|PRIVATE/u,
  );
});

test('a category-only possibleChain never promotes a weak match into a related-family claim', async () => {
  const f = fixture(
    row('seed', 'Museum Junipera Quay', [
      { longText: 'Vesper', types: ['locality'] },
    ]),
  );
  const result = await f.poi.firstPass(
    {
      ...recognition,
      clues: [{ ...recognition.clues[0], possibleChain: 'Museum' }],
    },
    { cityOverride: 'Vesper' },
    normalized('Vesper'),
  );
  assert.equal(result.status, 'resolved');
  assert.notEqual(result.candidate.relationship, 'related_chain_location');
  assert.ok(
    f.events.some(
      (e) =>
        e.event === 'google_related_expansion' &&
        e.reason === 'no_chain_evidence',
    ),
  );
});
