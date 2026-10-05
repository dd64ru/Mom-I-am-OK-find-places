import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RecognitionSchema,
  storedCandidate,
  DiscoverySchema,
} from '@places/schemas';
import {
  GooglePlacesPoi,
  OpenAiSearch,
  visionInstructions,
} from '@places/providers';
import { googleSearchPlan } from '../packages/providers/dist/google-search-plan.js';
import { planPlaceLabels } from '@places/core';
const noEvidence = { status: 'no_evidence', candidates: [], references: [] };
const recognition = RecognitionSchema.parse({
  visibleText: ['PRIVATE_TEXT', 'Unrelated Phone'],
  clues: [
    {
      name: 'Juniper',
      signage: 'GRAND JUNIPER',
      aliases: ['Speculative Alias'],
      possibleChain: 'Juniper',
      category: 'restaurant',
      confidence: 0.2,
    },
  ],
});
const row = (id, text, city = 'Vesper') => ({
  id,
  displayName: { text },
  location: { latitude: 1, longitude: 2 },
  formattedAddress: `20 Road, ${city}`,
  types: ['restaurant'],
  addressComponents: [
    { longText: city, types: ['locality'] },
    { longText: 'Country', shortText: 'FR', types: ['country'] },
  ],
});
function fixture() {
  const requests = [],
    events = [];
  const poi = new GooglePlacesPoi(
    async () => 'fixture-token',
    'fixture-project',
    async (_url, init) => {
      const q = JSON.parse(init.body);
      requests.push(q);
      return Response.json({
        places:
          q.textQuery === 'Juniper locations, Vesper'
            ? [
                row('related', 'Juniper Riverside Bistro'),
                row('exact', 'Juniper Grand'),
                row('unrelated', 'Museum'),
                row('wrong', 'Juniper Deli', 'Another City'),
              ]
            : [
                row('related', 'Juniper Riverside Bistro'),
                row('exact', 'Juniper Grand'),
              ],
      });
    },
    Date.now,
    (e) => events.push(e),
  );
  return { poi, requests, events };
}
test('structured primary signage survives recognition and receives a bounded query before speculative/cited aliases', () => {
  assert.match(visionInstructions, /primary storefront signage/u);
  const plan = googleSearchPlan(
    recognition,
    {
      ...noEvidence,
      status: 'verified',
      references: [
        {
          provider: 'web',
          url: 'https://example.org',
          observedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      candidates: [
        {
          canonicalName: 'Speculative Alias',
          aliases: [],
          cityAliases: [],
          category: 'restaurant',
          confidence: 1,
        },
      ],
    },
    { cityOverride: 'Vesper' },
  );
  assert.match(plan.queries[0], /^GRAND JUNIPER/u);
  assert.ok(plan.queries.length <= 2);
  assert.equal(JSON.stringify(plan.queries).includes('PRIVATE_TEXT'), false);
});
test('supported family expansion is one extra lookup; exact photographed venue ranks above related locations; conflicts/unrelated IDs stay excluded', async () => {
  const f = fixture(),
    scope = f.poi.beginAttempt();
  const first = await scope.firstPass(recognition, { cityOverride: 'Vesper' });
  const result = await scope.resolve(recognition, noEvidence, {
    cityOverride: 'Vesper',
  });
  assert.equal(first.status, 'alternatives');
  assert.equal(result.status, 'alternatives');
  assert.deepEqual(
    result.candidates.map((c) => c.providerIdentity.id),
    ['exact', 'related'],
  );
  assert.equal(result.candidates[0].relationship, 'likely_exact');
  assert.equal(result.candidates[1].relationship, 'related_chain_location');
  assert.equal(f.requests.length, 5);
  assert.equal(
    f.requests.filter((q) => q.textQuery === 'Juniper locations, Vesper')
      .length,
    1,
  );
  assert.ok(f.events.some((e) => e.phase === 'google_related_pass'));
  for (const c of result.candidates) {
    const stored = storedCandidate(c);
    assert.equal('address' in stored, false);
    assert.equal('coordinates' in stored, false);
    assert.equal('canonicalName' in stored, false);
  }
  for (const secret of [
    'GRAND JUNIPER',
    'Juniper Riverside Bistro',
    '20 Road',
    'Vesper',
    'fixture-token',
    'PRIVATE_TEXT',
  ])
    assert.equal(JSON.stringify(f.events).includes(secret), false);
});
test('generic chain token never authorizes membership or triggers expansion; provider city displays independently of cross-script equivalence', async () => {
  const requests = [];
  const poi = new GooglePlacesPoi(
    async () => 'fixture-token',
    'fixture-project',
    async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return Response.json({ places: [row('only', 'Juniper Grand')] });
    },
  );
  const r = {
    ...recognition,
    clues: [{ ...recognition.clues[0], possibleChain: 'Restaurant' }],
  };
  const result = await poi.firstPass(r, { cityOverride: 'Веспер' });
  assert.equal(result.status, 'resolved');
  assert.equal(result.candidate.address.city, 'Vesper');
  assert.equal(result.candidate.candidateConfidence, 'medium');
  assert.equal(requests.length, 1);
  assert.notEqual(result.candidate.relationship, 'related_chain_location');
});
test('city linguistic normalization is a separate no-tool call, independent of venue citations', async () => {
  const original = globalThis.fetch,
    requests = [];
  try {
    globalThis.fetch = async (_url, init) => {
      requests.push(JSON.parse(init.body));
      const text = JSON.stringify({
        canonicalName: 'Vesper',
        aliases: ['Веспер'],
        countryCode: 'FR',
        confidence: 0.95,
      });
      return new Response(
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\ndata: {"type":"response.completed"}\n\n`,
      );
    };
    const search = new OpenAiSearch(
      { accessToken: async () => 'fixture-token' },
      'fixture-model',
      'low',
      async () => {},
    );
    const normalized = await search.normalizeLocality('Веспер');
    assert.equal(normalized.input, 'Веспер');
    assert.equal(normalized.canonicalName, 'Vesper');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].tools, undefined);
    assert.equal(requests[0].store, false);
    assert.equal(JSON.stringify(requests[0].input).includes('Juniper'), false);
  } finally {
    globalThis.fetch = original;
  }
});
test('legacy single confirmation parses; multi-confirmed associations backfill each exact identity without relabelling related venues', () => {
  const source = (id) => ({
    provider: 'google-places',
    externalId: id,
    url: 'https://example.org/place',
    observedAt: '2026-01-01T00:00:00.000Z',
  });
  const candidates = ['exact', 'related'].map((id, i) => ({
    resolution: 'deterministic_poi',
    recognitionClueIndex: 0,
    providerIdentity: { provider: 'google-places', id },
    references: [source(id)],
    relationship: i ? 'related_chain_location' : 'likely_exact',
  }));
  const base = {
    id: 'discovery',
    workspaceId: 'fixture',
    source: source('exact'),
    recognition,
    candidates,
    visionProvider: 'fixture',
    status: 'confirmed',
    confirmedPlaceId: 'place1',
    confirmedPlaceIds: ['place1', 'place2'],
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const d = DiscoverySchema.parse(base);
  const places = candidates.map((c, i) => ({
    id: `place${i + 1}`,
    workspaceId: 'fixture',
    providerIdentity: c.providerIdentity,
    source: c.references[0],
    evidence: c.references,
    status: 'confirmed',
    tags: [],
    createdAt: base.createdAt,
    updatedAt: base.createdAt,
  }));
  assert.deepEqual(
    planPlaceLabels(places, [d]).updates.map((p) => p.placeId),
    ['place1'],
  );
  const { confirmedPlaceIds, ...legacy } = base;
  assert.equal(
    DiscoverySchema.safeParse({ ...legacy, candidates: [candidates[0]] })
      .success,
    true,
  );
});
