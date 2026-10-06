import test from 'node:test';
import assert from 'node:assert/strict';
import { GooglePlacesPoi, FallbackPoi } from '@places/providers';
import { PoiResolutionSchema, storedCandidate } from '@places/schemas';
import {
  row,
  recognition,
  verification,
  token,
  project,
} from './fixtures/google-places.mjs';
const noEvidence = { status: 'no_evidence', candidates: [], references: [] };
const branch = (id, text = row.displayName.text) => ({
  ...row,
  id,
  displayName: { text },
});
function fixture(rows) {
  const events = [],
    requests = [];
  const provider = new GooglePlacesPoi(
    async () => token,
    project,
    async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return Response.json({
        places: typeof rows === 'function' ? rows(requests.length) : rows,
      });
    },
    Date.now,
    (e) => events.push(e),
  );
  return { provider, events, requests };
}
test('three comparable branches stay separate and bounded; display ranking never confirms a branch', async () => {
  const { provider } = fixture(
    ['a', 'b', 'c', 'd', 'e'].map((id) => branch(id)),
  );
  const result = await provider.resolve(recognition, verification);
  assert.equal(result.status, 'alternatives');
  assert.deepEqual(
    result.candidates.map((c) => c.providerIdentity.id),
    ['a', 'b', 'c', 'd', 'e'],
  );
  assert.ok(result.candidates.every((c) => c.candidateConfidence === 'low'));
  assert.equal(PoiResolutionSchema.safeParse(result).success, true);
  for (const c of result.candidates) {
    const stored = storedCandidate(c);
    assert.equal('canonicalName' in stored, false);
    assert.equal('coordinates' in stored, false);
    assert.equal('address' in stored, false);
    assert.equal('attributions' in stored, false);
  }
});
test('one meaningful candidate keeps direct high/medium behavior; country/city absence remains neutral', async () => {
  const { provider } = fixture([row]);
  assert.equal(
    (await provider.resolve(recognition, verification)).candidate
      .candidateConfidence,
    'high',
  );
  const unknown = fixture([
    { ...row, formattedAddress: '', addressComponents: [] },
  ]);
  const result = await unknown.provider.firstPass(recognition, {
    cityOverride: 'Madrid',
  });
  assert.equal(result.status, 'resolved');
  assert.equal(result.candidate.candidateConfidence, 'medium');
});
test('query-relevant weak candidates surface only as low alternatives, including a repeated single ID', async () => {
  for (const ids of [
    ['a', 'b', 'c'],
    ['a', 'a'],
  ]) {
    const { provider, requests } = fixture(
      ids.map((id) => branch(id, 'Fixture Cafe Airport Branch')),
    );
    const result = await provider.firstPass(recognition);
    if (new Set(ids).size === 1) {
      assert.equal(result.status, 'resolved');
      assert.equal(result.candidate.candidateConfidence, 'low');
      continue;
    }
    assert.equal(result.status, 'alternatives');
    assert.equal(result.candidates.length, new Set(ids).size);
    assert.ok(result.candidates.every((c) => c.candidateConfidence === 'low'));
    assert.equal(requests.length, 2);
  }
});
test('attempt deduplicates across queries and both phases, with stable content-free diagnostic slots', async () => {
  const { provider, events, requests } = fixture((n) =>
    n === 1
      ? [branch('a'), branch('b')]
      : n === 2
        ? [branch('b'), branch('c')]
        : [branch('c'), branch('a'), branch('b')],
  );
  const attempt = provider.beginAttempt();
  const first = await attempt.firstPass(recognition);
  assert.equal(first.status, 'alternatives');
  const final = await attempt.resolve(recognition, verification);
  assert.equal(final.status, 'alternatives');
  assert.equal(final.candidates.length, 3);
  assert.equal(
    new Set(final.candidates.map((c) => c.providerIdentity.id)).size,
    3,
  );
  assert.equal(requests.length, 4);
  const candidates = events.filter(
    (e) => e.event === 'google_places_candidate',
  );
  assert.deepEqual(
    [...new Set(candidates.map((e) => e.candidateSlot))].sort(),
    [1, 2, 3],
  );
  assert.deepEqual(
    candidates
      .filter((e) => e.phase === 'google_enriched_pass')
      .map((e) => e.candidateSlot),
    [3, 1, 2, 3, 1, 2],
  );
  assert.ok(
    candidates
      .filter((e) => e.phase === 'google_enriched_pass')
      .every((e) => e.seenInMultipleQueries),
  );
  const allowed = [
    'event',
    'phase',
    'query',
    'candidateSlot',
    'providerRank',
    'nameEvidence',
    'nameRankPermille',
    'localityState',
    'localityEvidence',
    'countryState',
    'addressState',
    'categoryState',
    'finalRankPermille',
    'candidateConfidence',
    'decision',
    'seenInMultipleQueries',
    'relationship',
  ];
  for (const e of candidates) {
    assert.deepEqual(Object.keys(e).sort(), allowed.toSorted());
    assert.ok(
      e.query >= 1 &&
        e.query <= 2 &&
        e.candidateSlot <= 40 &&
        e.providerRank <= 10,
    );
    for (const k of ['nameRankPermille', 'finalRankPermille'])
      assert.ok(Number.isInteger(e[k]) && e[k] >= 0 && e[k] <= 1000);
  }
  for (const privateText of [
    row.id,
    row.displayName.text,
    row.formattedAddress,
    'Shanghai',
    'PRIVATE_VISIBLE_TEXT',
    token,
    '31.23',
    '121.45',
  ])
    assert.equal(JSON.stringify(events).includes(privateText), false);
  // A later discovery/correction gets an independent slot scope.
  const second = provider.beginAttempt();
  await second.firstPass(recognition);
  assert.equal(
    events.filter((e) => e.event === 'google_places_candidate').at(-3)
      .candidateSlot,
    1,
  );
});
test('wrong-city rows are excluded while valid siblings survive; all conflicts or unrelated identity remain unresolved', async () => {
  const wrong = branch('wrong');
  wrong.addressComponents = wrong.addressComponents.map((c) =>
    c.types.includes('locality')
      ? { ...c, longText: 'Madrid', shortText: 'Madrid' }
      : c,
  );
  const result = await fixture([
    wrong,
    branch('valid-a'),
    branch('valid-b'),
  ]).provider.resolve(recognition, verification);
  assert.equal(result.status, 'alternatives');
  assert.deepEqual(
    result.candidates.map((c) => c.providerIdentity.id),
    ['valid-a', 'valid-b'],
  );
  assert.equal(
    (await fixture([wrong]).provider.resolve(recognition, verification)).status,
    'unresolved',
  );
  assert.equal(
    (
      await fixture([branch('unrelated', 'Juniper Museum')]).provider.resolve(
        recognition,
        verification,
      )
    ).status,
    'unresolved',
  );
});
test('Google shortlist is preserved through fallback and cannot be converted to an automatic OSM choice', async () => {
  const { provider } = fixture([branch('a'), branch('b')]);
  let osm = 0;
  const fallback = new FallbackPoi(provider, {
    resolve: async () => {
      osm++;
      throw Error('must_not_fallback');
    },
  });
  assert.equal(
    (await fallback.beginAttempt().resolve(recognition, verification)).status,
    'alternatives',
  );
  assert.equal(osm, 0);
});

test('oversized valid response retains a bounded processing/telemetry budget and cannot claim unique certainty', async () => {
  const { provider, events } = fixture(
    Array.from({ length: 15 }, (_, i) => branch(`oversized-${i}`)),
  );
  const result = await provider.resolve(recognition, verification);
  assert.equal(result.status, 'alternatives');
  assert.equal(result.candidates.length, 8);
  const candidateEvents = events.filter(
    (e) => e.event === 'google_places_candidate',
  );
  assert.equal(candidateEvents.length, 20);
  assert.ok(
    candidateEvents.every((e) => e.candidateSlot <= 10 && e.providerRank <= 10),
  );
  assert.ok(
    events
      .filter((e) => e.event === 'google_places_parse')
      .every((e) => e.rowsUsable === 15),
  );
});

test('alternatives schema fails closed for non-Google, missing identity, duplicate IDs and unbounded lists', async () => {
  const result = await fixture([branch('a'), branch('b')]).provider.resolve(
    recognition,
    verification,
  );
  const valid = result.candidates[0];
  for (const candidates of [
    [],
    [valid, valid],
    Array(9).fill(valid),
    [{ ...valid, providerIdentity: undefined }],
    [{ ...valid, providerIdentity: { provider: 'nominatim', id: 'node/123' } }],
  ])
    assert.equal(
      PoiResolutionSchema.safeParse({ status: 'alternatives', candidates })
        .success,
      false,
    );
});
