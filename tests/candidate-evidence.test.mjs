import { assertGoogleAlternatives } from './fixtures/google-places.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { venueNameEvidence } from '../packages/providers/dist/place-matching.js';
import { decideCandidate } from '../packages/providers/dist/google-candidate-decision.js';
import { GooglePlacesPoi } from '@places/providers';
import { row, token, project } from './fixtures/google-places.mjs';
const noEvidence = { status: 'no_evidence', candidates: [], references: [] };
const recognition = (name = 'Alimentari', category = 'cafe') => ({
  visibleText: ['PRIVATE_CONTENT'],
  clues: [{ name, aliases: [], category, confidence: 0.1 }],
});
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
const alimentari = {
  ...row,
  displayName: { text: 'Alimentari Grande' },
  types: ['restaurant'],
};
const evidence = (nameEvidence = 'distinctive_equivalent', overrides = {}) => ({
  nameEvidence,
  nameRank: 0.9,
  localityState: 'unknown',
  countryState: 'unknown',
  addressState: 'absent',
  categoryState: 'unknown',
  verifiedWeb: false,
  providerRank: 1,
  finalRank: 0.4,
  ...overrides,
});
for (const [sign, official, expected] of [
  ['Alimentari', 'Alimentari', 'exact'],
  ['Grande Alimentari', 'Alimentari Grande', 'reordered'],
  ['Alimentari', 'Alimentari Grande', 'distinctive_equivalent'],
  ['The Museum Cafe', 'Museum Cafe', 'distinctive_equivalent'],
  ['Grand Foo Market', 'Foo Market', 'distinctive_equivalent'],
  ['Alimentari', 'Alimentari Riverside', 'strong_partial'],
  ['Alimentarri', 'Alimentari', 'bounded_typo'],
  ['Cafe', 'Museum Cafe', 'weak'],
  ['Airport', 'Alimentari', 'none'],
])
  test(`name evidence: ${sign} → ${expected}`, () => {
    assert.equal(venueNameEvidence(sign, official).nameEvidence, expected);
  });
test('strong unique identity accepts even at low rank and contradictory category', () => {
  assert.equal(
    decideCandidate(
      evidence('exact', { categoryState: 'conflict', finalRank: 0.1 }),
    ),
    'accepted_strong_identity',
  );
});
for (const type of ['strong_partial', 'bounded_typo'])
  test(`${type} allows unique meaningful identity with missing corroboration at low confidence`, () => {
    assert.equal(
      decideCandidate(evidence(type, { finalRank: 1, countryState: 'match' })),
      'accepted_partial_uncorroborated',
    );
    for (const [field, value, code] of [
      ['localityState', 'match', 'locality'],
      ['addressState', 'match', 'address'],
      ['verifiedWeb', true, 'web'],
      ['categoryState', 'compatible', 'category'],
      ['categoryState', 'related', 'category'],
    ])
      assert.equal(
        decideCandidate(evidence(type, { [field]: value })),
        `accepted_partial_with_${code}`,
      );
  });
for (const field of ['localityState', 'countryState', 'addressState'])
  test(`hard conflict ${field} overrides strong identity`, () => {
    assert.equal(
      decideCandidate(evidence('exact', { [field]: 'conflict', finalRank: 1 })),
      'rejected_hard_conflict',
    );
  });
test('identity class beats runner rank; comparable branches require locality/address separation', () => {
  for (const type of ['exact', 'distinctive_equivalent'])
    assert.equal(
      decideCandidate(evidence(type), evidence('weak', { finalRank: 1 })),
      'accepted_strong_identity',
    );
  const partial = evidence('strong_partial', {
    categoryState: 'compatible',
    finalRank: 0.9,
  });
  assert.equal(
    decideCandidate(partial, { ...partial, finalRank: 0.4 }),
    'ambiguous_competition',
  );
  assert.equal(
    decideCandidate({ ...partial, localityState: 'match' }, partial),
    'accepted_partial_with_locality',
  );
  assert.equal(
    decideCandidate({ ...partial, addressState: 'match' }, partial),
    'accepted_partial_with_address',
  );
  assert.equal(
    decideCandidate(
      evidence('exact', { finalRank: 1, categoryState: 'compatible' }),
      evidence('reordered', { finalRank: 0.2, categoryState: 'conflict' }),
    ),
    'ambiguous_competition',
  );
  assert.equal(
    decideCandidate(evidence('exact'), undefined, true),
    'ambiguous_competition',
  );
});
for (const city of [undefined, 'Shanghai'])
  test(`Alimentari unique distinctive identity resolves ${city ?? 'without city'} on first query`, async () => {
    const events = [],
      requests = [];
    const result = await provider([alimentari], events, requests).firstPass(
      recognition(),
      city ? { cityOverride: city } : {},
    );
    assert.equal(result.status, 'resolved');
    assert.equal(result.candidate.providerIdentity.id, row.id);
    assert.equal(requests.length, 1);
    const decision = events.find((e) => e.event === 'google_places_decision');
    assert.equal(decision.nameEvidence, 'distinctive_equivalent');
    assert.equal(decision.decision, 'accepted_strong_identity');
    assert.equal(decision.localityState, city ? 'match' : 'unknown');
    assert.equal(decision.categoryState, 'related');
    assert.equal(decision.nameRankPermille, 900);
    assert.equal(decision.runnerUpRankPermille, 0);
  });
for (const types of [
  ['university'],
  ['train_station'],
  ['street_address'],
  ['park'],
  ['deli'],
  ['food_store'],
])
  test(`category alone cannot veto strong identity: ${types}`, async () => {
    assert.equal(
      (
        await provider([{ ...alimentari, types }]).firstPass(recognition(), {
          cityOverride: 'Shanghai',
        })
      ).status,
      'resolved',
    );
  });
test('two partial names in different cities offer alternatives; explicit city resolves surviving branch', async () => {
  const shanghai = {
    ...alimentari,
    displayName: { text: 'Alimentari Riverside' },
  };
  const other = {
    ...shanghai,
    id: 'branch-two',
    displayName: { text: 'Alimentari Airport' },
    addressComponents: row.addressComponents.map((c) =>
      c.types.includes('locality')
        ? { ...c, longText: 'Guangzhou', shortText: 'Guangzhou' }
        : c,
    ),
  };
  for (const rows of [
    [shanghai, other],
    [other, shanghai],
  ]) {
    assertGoogleAlternatives(await provider(rows).firstPass(recognition()));
    const resolved = await provider(rows).firstPass(recognition(), {
      cityOverride: 'Shanghai',
    });
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.candidate.providerIdentity.id, row.id);
  }
});
test('strong identity ranks first among alternatives independently of provider order', async () => {
  const weak = {
    ...alimentari,
    id: 'weak-first',
    displayName: { text: 'Alimentari Airport Branch' },
  };
  for (const rows of [
    [weak, alimentari],
    [alimentari, weak],
  ]) {
    const result = await provider(rows).firstPass(recognition());
    assertGoogleAlternatives(result, 2);
    assert.equal(result.candidates[0].providerIdentity.id, row.id);
  }
});
test('Google decision telemetry contains exactly fixed evidence enums and integer ranks, including hard rejections', async () => {
  const events = [];
  await provider([alimentari], events).firstPass(recognition(), {
    cityOverride: 'Guangzhou',
  });
  const decisions = events.filter((e) => e.event === 'google_places_decision');
  assert.ok(decisions.length > 0);
  for (const e of decisions) {
    assert.deepEqual(
      Object.keys(e).sort(),
      [
        'event',
        'phase',
        'query',
        'nameEvidence',
        'nameRankPermille',
        'localityState',
        'countryState',
        'addressState',
        'categoryState',
        'finalRankPermille',
        'runnerUpRankPermille',
        'decision',
        'candidateConfidence',
      ].sort(),
    );
    assert.equal(e.decision, 'rejected_hard_conflict');
    assert.equal(e.localityState, 'conflict');
    for (const key of [
      'nameRankPermille',
      'finalRankPermille',
      'runnerUpRankPermille',
    ])
      assert.ok(Number.isInteger(e[key]) && e[key] >= 0 && e[key] <= 1000);
  }
  for (const value of [
    token,
    row.id,
    row.displayName.text,
    row.formattedAddress,
    'Alimentari',
    'Shanghai',
    'Guangzhou',
    'PRIVATE_CONTENT',
    '31.23',
    '121.45',
  ])
    assert.equal(JSON.stringify(events).includes(value), false);
});
test('unrelated generic-only identity stays unresolved; supported weak identity requires human selection', async () => {
  for (const name of ['Cafe', 'Alimentari Airport Branch']) {
    const result = await provider([
      { ...alimentari, displayName: { text: name } },
    ]).resolve(recognition(), noEvidence, { cityOverride: 'Shanghai' });
    if (name === 'Alimentari Airport Branch') {
      assert.equal(result.status, 'resolved');
      assert.equal(result.candidate.candidateConfidence, 'low');
    } else
      assert.deepEqual(result, {
        status: 'unresolved',
        reason: 'insufficient_evidence',
      });
  }
});

test('partial branch ranking prioritizes explicit locality over typo rank', async () => {
  const { compareEvidence } =
    await import('../packages/providers/dist/google-candidate-decision.js');
  const cityMatch = evidence('strong_partial', {
    localityState: 'match',
    finalRank: 0.8,
  });
  const higherRank = evidence('bounded_typo', {
    finalRank: 0.95,
    categoryState: 'compatible',
  });
  assert.ok(compareEvidence(cityMatch, higherRank) < 0);
  assert.equal(
    decideCandidate(cityMatch, higherRank),
    'accepted_partial_with_locality',
  );
});

test('weak relevant Google identity remains a human-selection alternative without OSM auto-selection', async () => {
  const { FallbackPoi } = await import('@places/providers');
  const weak = {
    ...alimentari,
    displayName: { text: 'Alimentari Airport Branch' },
  };
  let calls = 0;
  const fallback = new FallbackPoi(provider([weak]), {
    resolve: async () => {
      calls++;
      return { status: 'unresolved', reason: 'no_match' };
    },
  });
  assert.equal((await fallback.firstPass(recognition())).status, 'resolved');
  assert.equal(calls, 0);
  assert.equal(
    (await fallback.resolve(recognition(), noEvidence)).status,
    'resolved',
  );
  assert.equal(calls, 0);
});

test('unknown locality is neutral for all meaningful identity classes, but explicit conflict remains hard', () => {
  for (const type of [
    'exact',
    'reordered',
    'distinctive_equivalent',
    'strong_partial',
    'bounded_typo',
  ]) {
    const unverified = evidence(type, {
      localityState: 'unknown',
      countryState: 'match',
      addressState: 'match',
      verifiedWeb: true,
      categoryState: 'compatible',
      finalRank: 1,
    });
    assert.ok(decideCandidate(unverified).startsWith('accepted_'));
    assert.ok(
      decideCandidate({ ...unverified, localityState: 'match' }).startsWith(
        'accepted_',
      ),
    );
    assert.equal(
      decideCandidate({ ...unverified, localityState: 'conflict' }),
      'rejected_hard_conflict',
    );
  }
});
