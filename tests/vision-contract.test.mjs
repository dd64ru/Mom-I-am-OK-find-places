import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FreshRecognitionSchema,
  RecognitionSchema,
  DiscoverySchema,
} from '@places/schemas';
import {
  OpenAiVision,
  GeminiVision,
  visionInstructions,
} from '@places/providers';
const clue = (name) => ({
  name,
  nativeName: name,
  aliases: [],
  category: 'museum',
  confidence: 0.95,
});
// Follows the complete documented JSON shape, including optional native/alias
// fields and each supported explicit-public-recommendation evidence type.
const recommendations = {
  mode: 'recommendation_list',
  recommendationsTruncated: false,
  visibleText: [],
  clues: ['Cedar Gallery', 'Кедровый Дом', '風鈴堂', 'AX'].map((name, i) => ({
    ...clue(name),
    recommendationEvidence: [
      'numbered_list',
      'caption',
      'editorial',
      'numbered_list',
    ][i],
  })),
};
const images = [{ mimeType: 'image/png', bytes: new Uint8Array([1]) }];
async function withVision(provider, payload, run) {
  const previous = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/models'))
      return Response.json({
        models: [
          {
            slug: 'fixture-model',
            display_name: 'Fixture',
            visibility: 'list',
          },
        ],
      });
    requests.push(JSON.parse(init.body));
    if (provider === 'openai')
      return new Response(
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: JSON.stringify(payload) })}\n\ndata: {"type":"response.completed"}\n\n`,
      );
    return Response.json({
      candidates: [
        {
          finishReason: 'STOP',
          content: { parts: [{ text: JSON.stringify(payload) }] },
        },
      ],
    });
  };
  try {
    const vision =
      provider === 'openai'
        ? new OpenAiVision(
            { accessToken: async () => 'fixture-access' },
            'fixture-model',
            'medium',
          )
        : new GeminiVision('fixture-key', 'fixture-model');
    if (provider === 'openai') await vision.validateModel();
    await run(vision, requests);
  } finally {
    globalThis.fetch = previous;
  }
}
for (const provider of ['openai', 'gemini']) {
  test(`${provider} real recognition parser accepts documented four-recommendation JSON contract`, async () => {
    await withVision(provider, recommendations, async (vision, requests) => {
      const result = await vision.recognize(images);
      assert.deepEqual(result.recognition, recommendations);
      const instructions =
        provider === 'openai'
          ? requests[0].instructions
          : requests[0].systemInstruction.parts[0].text;
      assert.equal(instructions, visionInstructions);
      const contract = instructions.slice(
        instructions.indexOf('Return only a JSON object'),
      );
      assert.match(
        contract,
        /"recommendationEvidence"\?: "numbered_list" \| "caption" \| "editorial"/,
      );
      assert.match(contract, /REQUIRED on EVERY recommendation_list clue/);
      assert.match(contract, /FORBIDDEN\/omitted on every single_venue clue/);
      assert.match(contract, /never populate it from recommendation-list text/);
    });
  });
  for (const [kind, payload] of [
    [
      'missing list evidence',
      {
        ...recommendations,
        clues: recommendations.clues.map(
          ({ recommendationEvidence, ...c }) => c,
        ),
      },
    ],
    [
      'missing mode with four clues',
      {
        visibleText: [],
        clues: recommendations.clues.map(
          ({ recommendationEvidence, ...c }) => c,
        ),
      },
    ],
    [
      'explicit single mode with four clues',
      {
        mode: 'single_venue',
        visibleText: [],
        clues: recommendations.clues.map(
          ({ recommendationEvidence, ...c }) => c,
        ),
      },
    ],
    [
      'single mode carrying list evidence',
      {
        mode: 'single_venue',
        visibleText: [],
        clues: [recommendations.clues[0]],
      },
    ],
  ])
    test(`${provider} fresh recognition rejects ${kind} through provider parser`, async () => {
      await withVision(provider, payload, async (vision) => {
        if (provider === 'openai')
          await assert.rejects(vision.recognize(images), {
            message: 'openai_output_invalid',
          });
        else await assert.rejects(vision.recognize(images));
      });
    });
}
test('fresh single-venue mode rejects list-only metadata even with omitted mode or false truncation', () => {
  for (const mode of [undefined, 'single_venue']) {
    const r = {
      ...(mode ? { mode } : {}),
      visibleText: [],
      clues: [clue('Cedar Gallery')],
    };
    assert.equal(FreshRecognitionSchema.safeParse(r).success, true);
    assert.equal(
      FreshRecognitionSchema.safeParse({
        ...r,
        clues: [recommendations.clues[0]],
      }).success,
      false,
    );
    for (const recommendationsTruncated of [true, false])
      assert.equal(
        FreshRecognitionSchema.safeParse({ ...r, recommendationsTruncated })
          .success,
        false,
      );
  }
});
test('durable legacy recognition decoder remains compatible without permitting fresh four-clue downgrade', () => {
  const legacy = {
    visibleText: [],
    clues: [
      'Cedar Gallery',
      'Maple Gallery',
      'Willow Gallery',
      'Birch Gallery',
    ].map(clue),
  };
  assert.deepEqual(RecognitionSchema.parse(legacy), legacy);
  assert.equal(FreshRecognitionSchema.safeParse(legacy).success, false);
  const d = {
    id: 'legacy-four',
    workspaceId: 'fixture',
    recognition: legacy,
    candidates: [],
    source: { provider: 'fixture', observedAt: '2026-01-01T00:00:00.000Z' },
    visionProvider: 'fixture',
    status: 'unresolved',
    revision: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  assert.deepEqual(DiscoverySchema.parse(d).recognition, legacy);
  assert.deepEqual(
    FreshRecognitionSchema.parse(recommendations),
    recommendations,
  );
});
test('vision contract defines cityHint as a confident city or municipality, separate from areaHint', () => {
  const contract = visionInstructions.slice(
    visionInstructions.indexOf('Return only a JSON object'),
  );
  assert.match(contract, /"areaHint"\?: string, "cityHint"\?: string/);
  assert.match(contract, /areaHint keeps its broader search-locality meaning/);
  assert.match(
    contract,
    /cityHint is narrower and optional: the CITY OR MUNICIPALITY/,
  );
  assert.match(
    contract,
    /Never put a district, borough, neighbourhood, province, state, country or landmark in cityHint/,
  );
  assert.match(
    contract,
    /Omit cityHint whenever the city cannot be determined confidently/,
  );
});
for (const provider of ['openai', 'gemini'])
  test(`${provider} recognition parser keeps an optional cityHint beside areaHint`, async () => {
    const payload = {
      mode: 'single_venue',
      visibleText: [],
      clues: [
        {
          ...clue('Cedar Gallery'),
          areaHint: 'Pudong, Shanghai',
          cityHint: 'Shanghai',
        },
      ],
    };
    await withVision(provider, payload, async (vision) => {
      const result = await vision.recognize(images);
      assert.equal(result.recognition.clues[0].cityHint, 'Shanghai');
      assert.equal(result.recognition.clues[0].areaHint, 'Pudong, Shanghai');
    });
  });
test('legacy recognition without cityHint still parses', () => {
  const legacy = {
    mode: 'single_venue',
    visibleText: [],
    clues: [{ ...clue('Cedar Gallery'), areaHint: 'Shanghai' }],
  };
  assert.deepEqual(RecognitionSchema.parse(legacy), legacy);
  assert.equal(RecognitionSchema.parse(legacy).clues[0].cityHint, undefined);
});
