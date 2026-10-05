import { assertGoogleAlternatives } from './fixtures/google-places.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  GooglePlacesPoi,
  OpenAiSearch,
  searchInstructions,
  visionInstructions,
} from '@places/providers';
import { DiscoverySchema, VerificationSchema } from '@places/schemas';
import { ProcessingStatus } from '../apps/functions/dist/processing-status.js';
import { Ingress } from '../apps/functions/dist/ingress.js';
import { TelegramInteractions } from '../apps/functions/dist/interactions.js';
import {
  row,
  recognition,
  verification,
  token,
  project,
} from './fixtures/google-places.mjs';
const clone = structuredClone;
function evidence(name = 'Grande Alimentari') {
  const r = clone(recognition),
    v = clone(verification);
  r.clues[0] = { name, aliases: [], category: 'cafe', confidence: 0.95 };
  v.candidates[0] = {
    ...v.candidates[0],
    canonicalName: name,
    nativeName: undefined,
    aliases: [],
    addressClue: undefined,
  };
  return { r, v };
}
function provider(rows, log = [], calls = []) {
  return new GooglePlacesPoi(
    async () => token,
    project,
    async (_url, init) => {
      calls.push(JSON.parse(init.body));
      return Response.json({
        places: typeof rows === 'function' ? rows(calls.length) : rows,
      });
    },
    () => Date.parse('2026-01-01T00:00:00Z'),
    (event) => log.push(event),
  );
}
for (const [sign, official] of [
  ['Grande Alimentari', 'Alimentari Grande'],
  ['Alimentari Grande', 'Grande Alimentari'],
  ['Alimentari', 'Alimentari Grande'],
  ['Grande Alimentarri', 'Alimentari Grande'],
])
  test(`bounded venue recall: ${sign} / ${official}`, async () => {
    const { r, v } = evidence(sign);
    const result = await provider([
      { ...row, displayName: { text: official } },
    ]).resolve(r, v);
    assert.equal(result.status, 'resolved');
    assert.equal(result.candidate.providerIdentity.id, row.id);
    assert.deepEqual(result.candidate.coordinates, {
      ...row.location,
      crs: 'WGS84',
    });
  });
for (const unrelated of [
  'Grande',
  'Cafe',
  'restaurant',
  'University',
  'Completely Unrelated',
  'Alimentary Bakery Airport',
])
  test(`generic/unrelated sign cannot authorize provider identity: ${unrelated}`, async () => {
    const { r, v } = evidence(unrelated);
    assert.notEqual(
      (
        await provider([
          { ...row, displayName: { text: 'Alimentari Grande' } },
        ]).resolve(r, v)
      ).status,
      'resolved',
    );
  });
test('distinctive-equivalent signs accept without country and still reject explicit country/city/house conflicts', async () => {
  const { r, v } = evidence('Alimentari');
  for (const wrong of [
    {
      ...row,
      addressComponents: row.addressComponents.map((c) =>
        c.types.includes('country') ? { ...c, shortText: 'JP' } : c,
      ),
    },
    {
      ...row,
      addressComponents: row.addressComponents.map((c) =>
        c.types.includes('locality')
          ? { ...c, longText: 'Guangzhou', shortText: 'Guangzhou' }
          : c,
      ),
    },
  ])
    assert.notEqual(
      (
        await provider([
          { ...wrong, displayName: { text: 'Alimentari Grande' } },
        ]).resolve(r, v)
      ).status,
      'resolved',
    );
  const cityless = clone(v);
  delete cityless.candidates[0].countryCode;
  assert.equal(
    (
      await provider([
        { ...row, displayName: { text: 'Alimentari Grande' } },
      ]).resolve(r, cityless)
    ).status,
    'resolved',
  );
  v.candidates[0].addressClue = 'No. 158 Anfu Road';
  assert.notEqual(
    (
      await provider([
        {
          ...row,
          displayName: { text: 'Alimentari Grande' },
          formattedAddress: '159 Anfu Rd, Shanghai',
        },
      ]).resolve(r, v)
    ).status,
    'resolved',
  );
});
test('two similarly scored Google branches stay ambiguous independently of result order', async () => {
  const { r, v } = evidence();
  const a = { ...row, displayName: { text: 'Alimentari Grande' } },
    b = {
      ...row,
      id: 'branch-two',
      displayName: { text: 'Grande Alimentari' },
    };
  for (const rows of [
    [a, b],
    [b, a],
  ])
    assertGoogleAlternatives(await provider(rows).resolve(r, v));
});
test('strong identity outranks partial evidence without a universal numeric margin', async () => {
  const { r, v } = evidence();
  const exact = { ...row, displayName: { text: 'Alimentari Grande' } };
  const partial = {
    ...row,
    id: 'branch-two',
    displayName: { text: 'Alimentari Grande Riverside' },
  };
  assert.equal(
    (await provider([exact, partial]).resolve(r, v)).status,
    'alternatives',
  );
  const weak = clone(v);
  weak.candidates[0].category = 'place';
  delete weak.candidates[0].countryCode;
  assert.equal(
    (await provider([exact, partial]).resolve(r, weak)).status,
    'alternatives',
  );
});
test('structured query variants recover on second request, stop after confidence and never exceed two per phase', async () => {
  const { r, v } = evidence();
  v.candidates[0].aliases = ['Alimentari', 'Alimentari Restaurant'];
  const calls = [];
  const result = await provider(
    (n) =>
      n === 1 ? [] : [{ ...row, displayName: { text: 'Alimentari Grande' } }],
    [],
    calls,
  ).resolve(r, v);
  assert.equal(result.status, 'resolved');
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].textQuery, calls[1].textQuery);
  const none = [];
  await provider([], [], none).resolve(r, v);
  assert.equal(none.length, 2);
  assert.equal(new Set(none.map((c) => c.textQuery)).size, 2);
  for (const q of none) {
    assert.ok(q.textQuery.length <= 800);
    assert.match(q.textQuery, /Shanghai/);
    assert.equal(JSON.stringify(q).includes('PRIVATE_VISIBLE_TEXT'), false);
  }
});
for (const input of [
  'Шанхай',
  'шанхай',
  'шанхайй',
  'Shanghai',
  '上海',
  '上海市',
])
  test(`semantic city intent without venue citation: ${input}`, async () => {
    const { r, v } = evidence();
    v.status = 'no_evidence';
    v.candidates = [];
    v.references = [];
    v.localityIntent = {
      input,
      canonicalName: 'Shanghai',
      aliases: ['Шанхай', '上海', '上海市'],
      countryCode: 'CN',
      confidence: 0.97,
    };
    const resolved = await provider([
      { ...row, displayName: { text: 'Alimentari Grande' } },
    ]).resolve(r, v, { cityOverride: input });
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.candidate.address.city, 'Shanghai');
    const conflicting = clone(v);
    conflicting.status = 'verified';
    conflicting.references = verification.references;
    conflicting.candidates = [
      { ...verification.candidates[0], city: 'Beijing', cityAliases: ['北京'] },
    ];
    assert.deepEqual(
      await provider([]).resolve(r, conflicting, { cityOverride: input }),
      { status: 'unresolved', reason: 'no_match' },
    );
  });
test('semantic city intent is general, high confidence and bound to this exact city reply', async () => {
  const { r, v } = evidence();
  v.status = 'no_evidence';
  v.candidates = [];
  v.references = [];
  v.localityIntent = {
    input: 'парииж',
    canonicalName: 'Paris',
    aliases: ['Париж'],
    countryCode: 'FR',
    confidence: 0.95,
  };
  const paris = {
    ...row,
    displayName: { text: 'Alimentari Grande' },
    addressComponents: [
      { longText: 'Paris', types: ['locality'] },
      { longText: 'France', shortText: 'FR', types: ['country'] },
    ],
    formattedAddress: 'Paris, France',
  };
  assert.equal(
    (await provider([paris]).resolve(r, v, { cityOverride: 'парииж' })).status,
    'resolved',
  );
  for (const bad of [
    { ...v.localityIntent, input: 'stale-city' },
    { ...v.localityIntent, confidence: 0.4 },
  ]) {
    assert.notEqual(
      (
        await provider([paris]).resolve(
          r,
          { ...v, localityIntent: bad },
          { cityOverride: 'парииж' },
        )
      ).status,
      'resolved',
    );
  }
  assert.equal(
    VerificationSchema.safeParse({
      ...v,
      localityIntent: { ...v.localityIntent, coordinates: row.location },
    }).success,
    false,
  );
});
test('multiple visually inferred landmarks with no readable text proceed to deterministic scoring', async () => {
  const r = {
    visibleText: [],
    clues: [
      { name: 'Unknown Cafe', aliases: [], category: 'cafe', confidence: 0.9 },
      {
        name: 'Sun Yat Sen University',
        aliases: [],
        category: 'university',
        confidence: 0.95,
      },
    ],
  };
  const v = {
    status: 'no_evidence',
    candidates: [],
    references: [],
    localityIntent: {
      input: '广州',
      canonicalName: 'Guangzhou',
      aliases: ['广州'],
      countryCode: 'CN',
      confidence: 0.95,
    },
  };
  const uni = {
    ...row,
    displayName: { text: 'Sun Yat-Sen University' },
    types: ['university'],
    addressComponents: [
      { longText: 'Guangzhou', types: ['locality'] },
      { longText: 'China', shortText: 'CN', types: ['country'] },
    ],
  };
  assert.equal(
    (await provider([uni]).resolve(r, v, { cityOverride: '广州' })).status,
    'resolved',
  );
  assert.match(visionInstructions, /Readable text is not required/);
});
const sse = (payload, count = 0, citations = false) =>
  new Response(
    [
      ...Array.from(
        { length: count },
        (_, i) =>
          `data: ${JSON.stringify({ type: 'response.output_item.added', item: { type: 'web_search_call', id: 'search-' + i } })}\n\n`,
      ),
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: JSON.stringify(payload) })}\n\n`,
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          status: 'completed',
          output: citations
            ? [
                { type: 'web_search_call', status: 'completed' },
                {
                  type: 'message',
                  content: [
                    {
                      annotations: [
                        {
                          type: 'url_citation',
                          url: 'https://example.org/public-evidence',
                        },
                      ],
                    },
                  ],
                },
              ]
            : [],
        },
      })}\n\n`,
    ].join(''),
  );
test('OpenAI normalization needs no citation; second search can supply protocol evidence, third is rejected', async () => {
  const original = globalThis.fetch;
  const search = new OpenAiSearch(
    { accessToken: async () => token },
    'fixture-model',
    'low',
    async () => {},
  );
  try {
    const intent = {
      canonicalName: 'Shanghai',
      aliases: ['Шанхай', '上海'],
      countryCode: 'CN',
      confidence: 0.96,
    };
    globalThis.fetch = async () =>
      sse({ candidates: [], localityIntent: intent });
    const normalized = await search.verify(recognition, {
      cityOverride: 'шанхайй',
    });
    assert.equal(normalized.status, 'no_evidence');
    assert.deepEqual(normalized.references, []);
    assert.deepEqual(normalized.localityIntent, {
      ...intent,
      input: 'шанхайй',
    });
    globalThis.fetch = async () =>
      sse(
        { candidates: verification.candidates, localityIntent: intent },
        2,
        true,
      );
    assert.equal(
      (await search.verify(recognition, { cityOverride: 'шанхайй' })).status,
      'verified',
    );
    globalThis.fetch = async () =>
      sse({ candidates: verification.candidates }, 3, true);
    await assert.rejects(search.verify(recognition), {
      message: 'openai_output_invalid',
    });
    globalThis.fetch = async () =>
      sse({
        candidates: [],
        localityIntent: { ...intent, providerIdentity: { id: 'invented' } },
      });
    await assert.rejects(
      search.verify(recognition, { cityOverride: 'шанхайй' }),
      { message: 'openai_output_invalid' },
    );
    assert.match(searchInstructions, /TWO web search/);
    assert.match(searchInstructions, /citation is NOT required/);
  } finally {
    globalThis.fetch = original;
  }
});
test('Google diagnostics contain only bounded counts/fixed codes, no source content; failures in logging are harmless', async () => {
  const { r, v } = evidence();
  const log = [];
  await provider(
    [{ ...row, displayName: { text: 'Alimentari Grande' } }],
    log,
  ).resolve(r, v);
  const filters = log.filter((e) => e.event === 'google_places_filter');
  assert.equal(filters[0].result, 'resolved');
  assert.equal(filters[0].accepted, 1);
  for (const event of filters) {
    assert.deepEqual(
      Object.keys(event).sort(),
      [
        'event',
        'phase',
        'query',
        'returned',
        'complete',
        'nameStrong',
        'categoryCompatible',
        'cityCompatible',
        'countryCompatible',
        'addressCompatible',
        'accepted',
        'result',
        'rejected',
      ].sort(),
    );
    for (const [key, value] of Object.entries(event))
      if (!['event', 'phase', 'result', 'rejected'].includes(key))
        assert.ok(Number.isInteger(value) && value >= 0 && value <= 10);
    for (const value of Object.values(event.rejected))
      assert.ok(Number.isInteger(value) && value >= 0 && value <= 10);
  }
  const json = JSON.stringify(log);
  for (const privateValue of [
    token,
    'Alimentari',
    'Shanghai',
    'PRIVATE_VISIBLE_TEXT',
    row.formattedAddress,
    '31.23',
    '121.45',
  ])
    assert.equal(json.includes(privateValue), false);
  const rejected = [];
  await provider(
    [{ ...row, displayName: { text: 'Unrelated Cafe' } }],
    rejected,
  ).resolve(r, v);
  assert.ok(
    rejected
      .filter((e) => e.event === 'google_places_filter')
      .every((e) => e.rejected.no_name_match === 1),
  );
  const harmless = new GooglePlacesPoi(
    async () => token,
    project,
    async () => Response.json({ places: [row] }),
    Date.now,
    () => {
      throw Error('logger failed');
    },
  );
  assert.equal(
    (await harmless.resolve(recognition, verification)).status,
    'resolved',
  );
});
class Documents {
  values = new Map();
  tail = Promise.resolve();
  change(path, fn) {
    const op = this.tail.then(() => {
      const next = fn(clone(this.values.get(path)));
      if (next.value) this.values.set(path, clone(next.value));
      return next.result;
    });
    this.tail = op.catch(() => {});
    return op;
  }
}
test('processing acknowledgement precedes expensive work, survives concurrent/retry ingress without duplicates, and is removed before final result', async () => {
  const docs = new Documents(),
    calls = [],
    active = new Map();
  let id = 0;
  const api = {
    call: async (method, body) => {
      calls.push([method, body]);
      if (method === 'deleteMessage') {
        active.delete(body.message_id);
        return {};
      }
      active.set(++id, body.text);
      return { message_id: id };
    },
  };
  const ingress = new Ingress(docs, 'fixture'),
    status = new ProcessingStatus(docs, api, 'fixture', -100);
  const key = await ingress.receive(-100, {
    kind: 'image',
    messageId: 1,
    fileId: 'fixture',
    userId: 11,
  });
  await assert.rejects(
    ingress.run(key, async (record) => {
      await status.start(key, record.messageId);
      assert.equal(calls[0][1].text, '🔎 Ищу место…');
      throw Error('fixture transient');
    }),
  );
  await Promise.all([status.start(key, 1), status.start(key, 1)]);
  await ingress.run(key, async () => {
    await status.start(key, 1);
    await status.complete(key);
    await api.call('sendMessage', { text: 'Готово' });
  });
  assert.equal(
    calls.filter(([m, b]) => m === 'sendMessage' && b.text === '🔎 Ищу место…')
      .length,
    1,
  );
  assert.deepEqual([...active.values()], ['Готово']);
  const saved = docs.values.get(
    `workspaces/fixture/pendingIngress/${key}/status/processing`,
  );
  assert.deepEqual(Object.keys(saved).sort(), ['claimed', 'messageId']);
  const source = await readFile(
    new URL('../apps/functions/src/runtime.ts', import.meta.url),
    'utf8',
  );
  assert.ok(
    source.indexOf('status.start(') <
      source.indexOf('const provider = await vision()'),
  );
  assert.ok(
    source.indexOf('status.complete(') <
      source.indexOf('return interactions.propose('),
  );
});
test('processing status send/delete/storage failure never fails expensive processing', async () => {
  const docs = new Documents();
  let sends = 0;
  const status = new ProcessingStatus(
    docs,
    {
      call: async (method) => {
        if (method === 'sendMessage') {
          sends++;
          return { message_id: 1 };
        }
        throw Error('private Telegram failure');
      },
    },
    'fixture',
    -100,
  );
  await status.start('retry', 1);
  await status.complete('retry');
  await status.start('retry', 1);
  assert.equal(sends, 1);
  await new ProcessingStatus(
    {
      change: async () => {
        throw Error('storage unavailable');
      },
    },
    { call: async () => assert.fail('no unclaimed external send') },
    'fixture',
    -100,
  ).start('no-send', 1);
  const fail = new ProcessingStatus(
    new Documents(),
    {
      call: async () => {
        throw Error('send failed');
      },
    },
    'fixture',
    -100,
  );
  await fail.start('fail', 1);
  await fail.complete('fail');
});
test('awaiting city produces only one final Russian ForceReply; retries do not add a proposal', async () => {
  const docs = new Documents(),
    calls = [];
  let id = 0;
  const api = {
    call: async (method, body) => {
      calls.push([method, body]);
      return { message_id: ++id };
    },
  };
  const interactions = new TelegramInteractions(
    docs,
    {},
    {},
    api,
    'fixture',
    -100,
    () => 1000,
  );
  const d = DiscoverySchema.parse({
    id: 'city',
    workspaceId: 'fixture',
    source: { provider: 'fixture', observedAt: '2026-01-01T00:00:00Z' },
    recognition,
    candidates: [],
    visionProvider: 'fixture',
    status: 'awaiting_city',
    revision: 1,
    createdAt: '2026-01-01T00:00:00Z',
  });
  await interactions.propose(d, 11, 1);
  await interactions.propose(d, 11, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].reply_markup.force_reply, true);
  assert.match(calls[0][1].text, /В каком городе/);
  assert.equal(calls[0][1].reply_markup.inline_keyboard, undefined);
});

test('each plausible identity keeps its own category/address evidence; competing numbered branches remain ambiguous', async () => {
  const { r, v } = evidence('Alimentari Grande');
  v.candidates[0].addressClue = '18 Fixture Road';
  const second = {
    ...v.candidates[0],
    canonicalName: 'Sun Yat Sen University',
    aliases: [],
    category: 'university',
    addressClue: '158 University Road',
  };
  v.candidates.push(second);
  const university = {
    ...row,
    displayName: { text: second.canonicalName },
    formattedAddress: '158 University Rd, Shanghai',
    types: ['university'],
    addressComponents: row.addressComponents.map((c) =>
      c.types.includes('street_number')
        ? { ...c, longText: '158', shortText: '158' }
        : c,
    ),
  };
  assert.equal((await provider([university]).resolve(r, v)).status, 'resolved');
  v.candidates[1] = { ...v.candidates[0], addressClue: '158 Fixture Road' };
  const a = { ...row, displayName: { text: 'Alimentari Grande' } },
    b = {
      ...row,
      id: 'second-branch',
      displayName: { text: 'Alimentari Grande' },
      formattedAddress: '158 Fixture Rd, Shanghai',
      addressComponents: row.addressComponents.map((c) =>
        c.types.includes('street_number')
          ? { ...c, longText: '158', shortText: '158' }
          : c,
      ),
    };
  assertGoogleAlternatives(await provider([a, b]).resolve(r, v));
});

test('a truncated wrong-country response does not poison a later valid query; a city-only alias is not venue evidence', async () => {
  const { r, v } = evidence();
  let calls = 0;
  const good = { ...row, displayName: { text: 'Alimentari Grande' } };
  const wrong = {
    ...good,
    addressComponents: row.addressComponents.map((c) =>
      c.types.includes('country') ? { ...c, shortText: 'JP' } : c,
    ),
  };
  const resolver = new GooglePlacesPoi(
    async () => token,
    project,
    async () =>
      Response.json(
        ++calls === 1
          ? { places: [wrong], nextPageToken: 'fixture-page' }
          : { places: [good] },
      ),
  );
  assert.equal((await resolver.resolve(r, v)).status, 'resolved');
  assert.equal(calls, 2);
  v.candidates[0].aliases = ['上海'];
  assert.notEqual(
    (await provider([{ ...row, displayName: { text: '上海' } }]).resolve(r, v))
      .status,
    'resolved',
  );
});
