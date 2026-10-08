import test from 'node:test';
import assert from 'node:assert/strict';
import { FreshRecognitionSchema } from '@places/schemas';
import { DiscoveryService } from '@places/core';
import { FirestoreRepository, GooglePlacesPoi } from '@places/providers';
import { MemoryDb } from './fixtures/memory-db.mjs';
import { googleSearchPlan } from '../packages/providers/dist/google-search-plan.js';
const empty = { status: 'no_evidence', candidates: [], references: [] };
const clue = (name, extra = {}) => ({
  name,
  aliases: [],
  category: 'tourist_attraction',
  confidence: 0.95,
  cityHint: 'Vesper',
  ...extra,
});
const numbered = {
  mode: 'recommendation_list',
  visibleText: ['4 Cedar Viewing Terrace'],
  clues: [
    clue('Cedar Viewing Terrace', {
      recommendationEvidence: 'numbered_list',
      nativeName: '杉木观景台',
      aliases: ['Cedar Terrace'],
    }),
  ],
};
const providerRow = (name, city = 'Vesper', country = 'FR') => ({
  id: 'provider-id',
  displayName: { text: name },
  types: ['tourist_attraction'],
  location: { latitude: 1, longitude: 2 },
  formattedAddress: `10 Road, ${city}`,
  addressComponents: [
    { longText: city, types: ['locality'] },
    { shortText: country, types: ['country'] },
  ],
});
async function serviceFor(
  recognition,
  response = [],
  search = { verify: async () => empty },
) {
  const db = new MemoryDb(),
    repo = new FirestoreRepository(db),
    time = new Date().toISOString();
  await repo.initWorkspace({
    id: 'shared',
    members: [],
    settings: { locale: 'en' },
    createdAt: time,
    updatedAt: time,
  });
  const queries = [],
    events = [];
  const poi = new GooglePlacesPoi(
    async () => 'fixture',
    'fixture-project',
    async (url, init) => {
      if (init.method === 'GET') return Response.json(response[0]);
      const query = JSON.parse(init.body).textQuery;
      queries.push(query);
      return Response.json({
        places: typeof response === 'function' ? response(query) : response,
      });
    },
    Date.now,
    (event) => events.push(event),
  );
  const service = new DiscoveryService(
    repo,
    {
      name: 'synthetic',
      recognize: async () => ({ provider: 'synthetic', recognition }),
    },
    { poi, search },
  );
  const ingest = () =>
    service.ingest({
      id: 'photo',
      workspaceId: 'shared',
      images: [{ mimeType: 'image/png', bytes: new Uint8Array([1]) }],
      source: { provider: 'telegram', observedAt: time },
    });
  return { db, repo, service, ingest, queries, events, poi };
}
test('one numbered attraction enters normal confirmation flow; names and uncertainty survive, no brand selection or save', async () => {
  const f = await serviceFor(numbered, [providerRow('杉木观景台')]);
  const discovery = await f.ingest();
  assert.equal(discovery.recognition.mode, 'single_venue');
  assert.equal(
    discovery.recognition.clues[0].recommendationEvidence,
    undefined,
  );
  assert.deepEqual(discovery.recognition.clues[0].aliases, ['Cedar Terrace']);
  assert.equal(discovery.status, 'needs_confirmation');
  assert.equal(discovery.selectedBrandIndices, undefined);
  assert.equal(discovery.candidates[0].providerIdentity.id, 'provider-id');
  assert.equal(
    f.events.some((e) => e.event === 'recommendation_brand_search'),
    false,
  );
  assert.equal(
    [...f.db.values.keys()].some((k) => k.includes('/places/')),
    false,
  );
});
test('several distinct recommendations retain brand selection, selected city and explicit multi-selection', async () => {
  const recognition = {
    ...numbered,
    clues: ['Cedar Viewing Terrace', 'Willow Gallery', 'Maple Park'].map(
      (name) => clue(name, { recommendationEvidence: 'numbered_list' }),
    ),
  };
  const f = await serviceFor(recognition, (query) => [
    {
      ...providerRow(query.split(',')[0], 'Chosen City'),
      id: query.split(',')[0],
    },
  ]);
  const list = await f.ingest();
  assert.equal(list.status, 'awaiting_brands');
  assert.equal(f.queries.length, 0);
  const first = await f.service.updateBrandSelection(list, 'toggle', 0);
  const selected = await f.service.updateBrandSelection(first, 'toggle', 2);
  const city = await f.repo.reviseDiscovery(
    'shared',
    selected.id,
    selected.revision,
    { cityOverride: 'Chosen City' },
  );
  const reviewed = await f.service.searchBrands(city);
  assert.equal(reviewed.status, 'needs_selection');
  assert.equal(reviewed.candidates.length, 2);
  assert.ok(f.queries.every((q) => q.includes('Chosen City')));
  assert.equal(
    [...f.db.values.keys()].some((k) => k.includes('/places/')),
    false,
  );
});
test('one genuine brand clue remains searchable as a chain after singleton normalization', async () => {
  const recognition = {
    ...numbered,
    clues: [
      clue('Junipera Gallery', {
        possibleChain: 'Junipera Gallery',
        recommendationEvidence: 'caption',
        category: 'museum',
      }),
    ],
  };
  const parsed = FreshRecognitionSchema.parse(recognition);
  assert.equal(parsed.mode, 'single_venue');
  assert.equal(parsed.clues[0].possibleChain, 'Junipera Gallery');
  const f = await serviceFor(recognition, [
    { ...providerRow('Junipera Gallery'), types: ['museum'] },
  ]);
  assert.equal((await f.ingest()).status, 'needs_confirmation');
});
test('skyline camera intent remains a viewpoint hypothesis, never the visible landmark pin', async () => {
  const recognition = {
    mode: 'scene_viewpoint',
    visibleText: [],
    scene: {
      landmarks: ['Cedar Tower'],
      cityHint: 'Vesper',
      countryCode: 'FR',
      context: 'skyline',
    },
    clues: [clue('Willow Park', { category: 'park', confidence: 0.4 })],
  };
  const f = await serviceFor(recognition, [
    providerRow('Willow Park'),
    { ...providerRow('Cedar Tower'), id: 'landmark-id' },
  ]);
  const discovery = await f.ingest();
  assert.equal(discovery.recognition.mode, 'scene_viewpoint');
  assert.equal(discovery.status, 'needs_confirmation');
  assert.equal(discovery.candidates[0].relationship, 'viewpoint_hypothesis');
  assert.equal(discovery.candidates[0].providerIdentity.id, 'provider-id');
});
test('ambiguous evidence stays unresolved instead of being converted to brand or camera search', async () => {
  const f = await serviceFor({
    mode: 'single_venue',
    visibleText: ['PRIVATE_LABEL'],
    clues: [],
  });
  const discovery = await f.ingest();
  assert.equal(discovery.status, 'unresolved');
  assert.equal(discovery.resolutionReason, 'no_place_evidence');
  assert.equal(f.queries.length, 0);
});
test('primary provider-supported native identity occupies an existing query slot before competing guesses', async () => {
  const r = {
    mode: 'single_venue',
    visibleText: [],
    clues: [
      clue('Cedar Viewing Terrace', {
        nativeName: '杉木观景台',
        aliases: ['Cedar Terrace'],
      }),
      clue('Uncertain Other Deck', { confidence: 0.4 }),
    ],
  };
  const plan = googleSearchPlan(r, empty, { cityOverride: 'Vesper' });
  assert.deepEqual(plan.queries, [
    '杉木观景台, Vesper',
    'Cedar Viewing Terrace, Vesper',
  ]);
  const f = await serviceFor(r, (query) =>
    query.startsWith('杉木') ? [providerRow('杉木观景台')] : [],
  );
  const result = await f.poi.firstPass(r, { cityOverride: 'Vesper' });
  assert.equal(result.status, 'resolved');
  assert.equal(result.candidate.providerIdentity.id, 'provider-id');
  assert.ok(f.queries.length <= 2);
});
test('cited alternative identity can be resolved only through matching provider name and geography', async () => {
  const r = FreshRecognitionSchema.parse(numbered);
  const verified = {
    status: 'verified',
    references: [
      {
        provider: 'fixture-web',
        url: 'https://example.org/terrace',
        observedAt: new Date().toISOString(),
      },
    ],
    candidates: [
      {
        canonicalName: 'The Lantern Deck',
        nativeName: '灯台观景台',
        aliases: ['Cedar Viewing Terrace'],
        category: 'tourist_attraction',
        city: 'Vesper',
        cityAliases: [],
        countryCode: 'FR',
        confidence: 0.95,
      },
    ],
  };
  for (const [name, city, country, accepted] of [
    ['灯台观景台', 'Vesper', 'FR', true],
    ['The Lanternist Deckside', 'Vesper', 'FR', false],
    ['Completely Unrelated Terrace', 'Vesper', 'FR', false],
    ['灯台观景台', 'Other City', 'FR', false],
    ['灯台观景台', 'Vesper', 'JP', false],
  ]) {
    const f = await serviceFor(r, [providerRow(name, city, country)]);
    const result = await f.poi.resolve(r, verified, { cityOverride: 'Vesper' });
    assert.equal(
      ['resolved', 'alternatives'].includes(result.status),
      accepted,
      `${name}/${city}/${country}`,
    );
  }
  const f = await serviceFor(r, [providerRow('The Lantern Deck')]);
  const unproven = await f.poi.resolve(
    r,
    { ...verified, status: 'no_evidence', references: [] },
    { cityOverride: 'Vesper' },
  );
  assert.equal(unproven.status, 'unresolved');
  assert.ok(f.events.some((e) => e.rejected?.no_name_match > 0));
});

test('Telegram presents a single numbered venue as a reviewable place and a real list as independent brand choices', async () => {
  const { TelegramInteractions } =
    await import('../apps/functions/dist/interactions.js');
  for (const multi of [false, true]) {
    const recognition = multi
      ? {
          ...numbered,
          clues: [
            numbered.clues[0],
            clue('Willow Gallery', { recommendationEvidence: 'caption' }),
          ],
        }
      : numbered;
    const f = await serviceFor(recognition, [providerRow('杉木观景台')]);
    const discovery = await f.ingest();
    const docs = new Map(),
      calls = [];
    const atomic = {
      change: async (path, fn) => {
        const { value, result } = fn(docs.get(path));
        if (value !== undefined) docs.set(path, value);
        return result;
      },
    };
    const api = {
      call: async (method, body) => {
        calls.push({ method, body });
        return { message_id: calls.length };
      },
    };
    const telegram = new TelegramInteractions(
      atomic,
      f.repo,
      f.service,
      api,
      'shared',
      -100,
    );
    await telegram.propose(discovery, 11, 1);
    const output = JSON.stringify(calls);
    if (multi) assert.match(output, /Отметить все бренды/);
    else {
      assert.doesNotMatch(output, /Отметить все бренды|Изменить выбор брендов/);
      assert.match(output, /подтверд/);
    }
    assert.equal(
      [...f.db.values.keys()].some((k) => k.includes('/places/')),
      false,
    );
  }
});

// Synthetic names/city reproduce the shortened numbered viewpoint pattern.
// All provider and web evidence is local; no production or provider requests.
test('numbered short viewpoint name resolves a prefixed provider title without exact string equality', async () => {
  const recognition = {
    mode: 'recommendation_list',
    visibleText: ['6 Juniper Viewing Platform'],
    clues: [
      clue('Juniper Viewing Platform', {
        category: 'viewpoint',
        recommendationEvidence: 'numbered_list',
      }),
    ],
  };
  const f = await serviceFor(recognition, [
    providerRow('The Stage Juniper Viewing Platform'),
  ]);
  const result = await f.ingest();
  assert.equal(result.recognition.mode, 'single_venue');
  assert.equal(result.status, 'needs_confirmation');
  assert.equal(result.candidates[0].providerIdentity.id, 'provider-id');
  assert.equal(
    [...f.db.values.keys()].some((k) => k.includes('/places/')),
    false,
  );
});

test('independently cited identity bridges a viewpoint alias through the real enriched discovery pass', async () => {
  const recognition = {
    mode: 'recommendation_list',
    visibleText: ['6 Juniper Viewing Platform'],
    clues: [
      clue('Juniper Viewing Platform', {
        category: 'observation deck',
        recommendationEvidence: 'numbered_list',
      }),
    ],
  };
  const verified = {
    status: 'verified',
    references: [
      {
        provider: 'fixture-web',
        url: 'https://example.org/venue',
        observedAt: new Date().toISOString(),
      },
    ],
    candidates: [
      {
        canonicalName: 'The Lantern Observation Deck',
        aliases: ['Juniper Viewing Platform'],
        category: 'viewpoint',
        city: 'Vesper',
        cityAliases: [],
        countryCode: 'FR',
        confidence: 0.95,
      },
    ],
  };
  let verificationCalls = 0;
  const search = {
    verify: async () => {
      verificationCalls++;
      return verified;
    },
  };
  const f = await serviceFor(
    recognition,
    (query) =>
      query.startsWith('The Lantern')
        ? [providerRow('The Lantern Observation Deck')]
        : [],
    search,
  );
  const result = await f.ingest();
  assert.equal(verificationCalls, 1);
  assert.equal(result.recognition.mode, 'single_venue');
  assert.equal(result.status, 'needs_confirmation');
  assert.equal(result.candidates[0].providerIdentity.id, 'provider-id');
  assert.ok(f.queries.some((q) => q.startsWith('Juniper Viewing Platform')));
  assert.ok(
    f.queries.some((q) => q.startsWith('The Lantern Observation Deck')),
  );
  assert.equal(
    [...f.db.values.keys()].some((k) => k.includes('/places/')),
    false,
  );
});

test('generic viewpoint descriptors alone cannot resolve a provider venue in the same city', async () => {
  for (const name of ['Viewing Platform', 'Observation Deck', 'Terrace']) {
    const f = await serviceFor(
      {
        mode: 'single_venue',
        visibleText: [name],
        clues: [clue(name, { category: 'viewpoint' })],
      },
      [providerRow('The Stage Juniper Viewing Platform')],
    );
    const result = await f.ingest();
    assert.equal(result.status, 'unresolved', name);
    assert.equal(result.candidates.length, 0, name);
  }
});

test('prefixed viewpoint identity retains competing alternatives and rejects a conflicting locality', async () => {
  const recognition = {
    mode: 'single_venue',
    visibleText: [],
    clues: [clue('Juniper Viewing Platform', { category: 'viewpoint' })],
  };
  const competing = await serviceFor(recognition, [
    providerRow('The Stage Juniper Viewing Platform'),
    {
      ...providerRow('The Stage Juniper Viewing Platform'),
      id: 'other-branch',
    },
  ]);
  const choices = await competing.ingest();
  assert.equal(choices.status, 'needs_selection');
  assert.equal(choices.candidates.length, 2);
  const conflicting = await serviceFor(recognition, [
    providerRow('The Stage Juniper Viewing Platform', 'Other City'),
  ]);
  const rejected = await conflicting.poi.firstPass(
    FreshRecognitionSchema.parse(recognition),
    { cityOverride: 'Vesper' },
  );
  assert.equal(rejected.status, 'unresolved');
  assert.equal(rejected.reason, 'locality_mismatch');
});
