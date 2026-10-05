import test from 'node:test';
import assert from 'node:assert/strict';
import { GooglePlacesPoi } from '@places/providers';
import {
  candidateConfidence,
  decideCandidate,
} from '../packages/providers/dist/google-candidate-decision.js';
import { row, token, project } from './fixtures/google-places.mjs';
const evidence = (nameEvidence, localityState = 'unknown') => ({
  nameEvidence,
  localityState,
  nameRank: 0.9,
  countryState: 'unknown',
  addressState: 'absent',
  categoryState: 'unknown',
  verifiedWeb: false,
  providerRank: 1,
  finalRank: 0.1,
});
for (const name of [
  'exact',
  'reordered',
  'distinctive_equivalent',
  'strong_partial',
  'bounded_typo',
])
  test(`confidence is discrete and unknown locality is eligible: ${name}`, () => {
    const e = evidence(name);
    assert.ok(decideCandidate(e).startsWith('accepted_'));
    assert.equal(
      candidateConfidence(e),
      ['strong_partial', 'bounded_typo'].includes(name) ? 'low' : 'medium',
    );
    assert.equal(
      candidateConfidence({ ...e, localityState: 'match' }),
      ['strong_partial', 'bounded_typo'].includes(name) ? 'medium' : 'high',
    );
    // Numeric rank, provider ordering, country or category never stand in for city evidence.
    assert.equal(
      candidateConfidence({
        ...e,
        finalRank: 1,
        countryState: 'match',
        categoryState: 'related',
      }),
      candidateConfidence(e),
    );
    assert.equal(
      decideCandidate(e, { ...e, finalRank: 0.01 }),
      'ambiguous_competition',
    );
    for (const key of ['localityState', 'countryState', 'addressState'])
      assert.equal(
        decideCandidate({ ...e, [key]: 'conflict' }),
        'rejected_hard_conflict',
      );
  });
const noEvidence = { status: 'no_evidence', candidates: [], references: [] };
for (const [city, country] of [
  ['Rome', 'IT'],
  ['Madrid', 'ES'],
  ['Seattle', 'US'],
  ['서울', 'KR'],
  ['шанхай', 'CN'],
])
  for (const [official, confidence] of [
    ['Juniper Museum', 'medium'],
    ['Juniper Museum Riverside', 'low'],
  ])
    test(`unique plausible result with unknown locality: ${city} / ${confidence}`, async () => {
      const requests = [],
        events = [];
      const candidate = {
        ...row,
        displayName: { text: official },
        types: ['museum'],
        formattedAddress: 'Provider address',
        addressComponents: [
          { longText: 'Country', shortText: country, types: ['country'] },
        ],
      };
      const poi = new GooglePlacesPoi(
        async () => token,
        project,
        async (_url, init) => {
          requests.push(JSON.parse(init.body));
          return Response.json({ places: [candidate] });
        },
        Date.now,
        (e) => events.push(e),
      );
      const r = await poi.resolve(
        {
          visibleText: [],
          clues: [
            {
              name: 'Juniper Museum',
              aliases: [],
              category: 'tourist_attraction',
              confidence: 0.01,
            },
          ],
        },
        noEvidence,
        { cityOverride: city },
      );
      assert.equal(r.status, 'resolved');
      assert.equal(r.candidate.candidateConfidence, confidence);
      assert.equal(r.candidate.providerIdentity.id, row.id);
      assert.equal(requests.length, 1);
      assert.ok(requests[0].textQuery.includes(city));
      const decision = events.find((e) => e.event === 'google_places_decision');
      assert.equal(decision.localityState, 'unknown');
      assert.equal(decision.candidateConfidence, confidence);
      for (const content of [official, city, row.id, token, 'Provider address'])
        assert.equal(JSON.stringify(events).includes(content), false);
    });

for (const [scenario, modify, expectedDecision] of [
  [
    'reliable wrong city',
    (r) => ({
      ...r,
      addressComponents: r.addressComponents.map((c) =>
        c.types.includes('locality') ? { ...c, longText: 'Portland' } : c,
      ),
    }),
    'rejected_hard_conflict',
  ],
  [
    'reliable wrong country',
    (r) => ({
      ...r,
      addressComponents: r.addressComponents.map((c) =>
        c.types.includes('country') ? { ...c, shortText: 'MX' } : c,
      ),
    }),
    'rejected_hard_conflict',
  ],
  [
    'comparable wrong house number',
    (r) => ({
      ...r,
      formattedAddress: '19 Fixture Road, Seattle',
      addressComponents: r.addressComponents.map((c) =>
        c.types.includes('street_number')
          ? { ...c, longText: '19', shortText: '19' }
          : c,
      ),
    }),
    'rejected_hard_conflict',
  ],
  [
    'unrelated identity',
    (r) => ({ ...r, displayName: { text: 'Orchard Aquarium' } }),
    'insufficient_identity',
  ],
  [
    'comparable branches',
    (r) => [r, { ...r, id: 'other-comparable-branch' }],
    'ambiguous_competition',
  ],
])
  test(`surfacing plausible candidates preserves ${scenario} veto`, async () => {
    const events = [];
    const baseline = {
      ...row,
      displayName: { text: 'Juniper Museum' },
      types: ['museum'],
      formattedAddress: '18 Fixture Road, Seattle',
      addressComponents: [
        { longText: 'Seattle', types: ['locality'] },
        { longText: 'United States', shortText: 'US', types: ['country'] },
        { longText: '18', types: ['street_number'] },
        { longText: 'Fixture Road', types: ['route'] },
      ],
    };
    const modified = modify(baseline);
    const poi = new GooglePlacesPoi(
      async () => token,
      project,
      async () =>
        Response.json({
          places: Array.isArray(modified) ? modified : [modified],
        }),
      Date.now,
      (e) => events.push(e),
    );
    const r = await poi.resolve(
      {
        visibleText: [],
        clues: [
          {
            name: 'Juniper Museum',
            aliases: [],
            category: 'museum',
            confidence: 0.1,
          },
        ],
      },
      {
        status: 'verified',
        candidates: [
          {
            canonicalName: 'Juniper Museum',
            aliases: [],
            category: 'museum',
            city: 'Seattle',
            cityAliases: [],
            countryCode: 'US',
            addressClue: '18 Fixture Road',
            confidence: 0.9,
          },
        ],
        references: [
          {
            provider: 'openai-web-search',
            url: 'https://example.org/venue',
            observedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
      { cityOverride: 'Seattle' },
    );
    assert.notEqual(r.status, 'resolved');
    const decision = events.find((e) => e.event === 'google_places_decision');
    if (decision) {
      assert.equal(decision.decision, expectedDecision);
      assert.equal(decision.candidateConfidence, undefined);
    } else assert.equal(expectedDecision, 'insufficient_identity');
  });
