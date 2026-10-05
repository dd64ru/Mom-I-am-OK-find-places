import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GooglePlacesPoi,
  GooglePlacesFailure,
  FallbackPoi,
  PipelineTelemetry,
  googlePlacesAdc,
  GOOGLE_PLACES_ENDPOINT,
  GOOGLE_PLACES_FIELD_MASK,
  GOOGLE_PLACES_SCOPE,
  GOOGLE_PLACES_DETAILS_SCOPE,
  canonicalPlaceId,
} from '@places/providers';
import { safeDiagnostic } from '../apps/functions/dist/webhook.js';
import {
  recognition,
  verification,
  row,
  token,
  project,
  googleFixture,
} from './fixtures/google-places.mjs';
const clone = (value) => structuredClone(value);
const noMatch = { status: 'unresolved', reason: 'no_match' };
test('Places New Text Search uses bounded structured evidence, ADC header auth and explicit quota project', async () => {
  const provider = googleFixture(undefined, async (url, options) => {
    assert.equal(url, GOOGLE_PLACES_ENDPOINT);
    assert.equal(new URL(url).search, '');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    assert.equal(options.headers['X-Goog-User-Project'], project);
    assert.equal('X-Goog-Api-Key' in options.headers, false);
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.equal(options.headers['X-Goog-FieldMask'], GOOGLE_PLACES_FIELD_MASK);
    assert.equal(GOOGLE_PLACES_FIELD_MASK.includes('*'), false);
    assert.deepEqual(GOOGLE_PLACES_FIELD_MASK.split(','), [
      'places.id',
      'places.displayName',
      'places.formattedAddress',
      'places.location',
      'places.types',
      'places.addressComponents',
      'places.attributions',
      'nextPageToken',
    ]);
    const input = JSON.parse(options.body);
    assert.deepEqual(input, {
      textQuery: '示例咖啡馆, Shanghai, 18 Fixture Road, CN',
      languageCode: 'en',
      pageSize: 10,
      includePureServiceAreaBusinesses: false,
      regionCode: 'CN',
    });
    for (const excluded of [
      'PRIVATE_VISIBLE_TEXT',
      'STALE_WORKSPACE_HINT',
      token,
    ])
      assert.equal(options.body.includes(excluded), false);
    return new Response(JSON.stringify({ places: [row] }));
  });
  const result = await provider.resolve(recognition, verification, {
    cityOverride: 'Шанхай',
    workspaceAreaHint: 'STALE_WORKSPACE_HINT',
  });
  assert.equal(result.status, 'resolved');
  assert.deepEqual(result.candidate.providerIdentity, {
    provider: 'google-places',
    id: row.id,
  });
  assert.deepEqual(result.candidate.coordinates, {
    ...row.location,
    crs: 'WGS84',
  });
  assert.equal(result.candidate.address.city, 'Shanghai');
  assert.deepEqual(result.candidate.attributions, row.attributions);
  assert.equal(
    canonicalPlaceId(result.candidate),
    canonicalPlaceId({
      ...result.candidate,
      canonicalName: 'Changed provider spelling',
    }),
  );
});
for (const name of [
  'Fixture Café',
  'Fixture-Cafe',
  'Fixture Coffee',
  '示例咖啡馆',
  'FC Shanghai',
]) {
  test(`deterministic canonical/native/structured alias name matching: ${name}`, async () => {
    const result = await googleFixture({
      places: [{ ...row, displayName: { text: name } }],
    }).resolve(recognition, verification);
    assert.equal(result.status, 'resolved');
  });
}
for (const [scenario, mutate, reason] of [
  [
    'wrong city',
    (r) => {
      r.addressComponents[2].longText = 'Guangzhou';
      r.addressComponents[2].shortText = 'Guangzhou';
    },
    'locality_mismatch',
  ],
  [
    'wrong country',
    (r) => {
      r.addressComponents[3].shortText = 'JP';
    },
    'locality_mismatch',
  ],
  [
    'wrong branch street number',
    (r) => {
      r.formattedAddress = '180 Fixture Road, Shanghai, China';
      r.addressComponents[0].longText = '180';
    },
    'no_match',
  ],
  [
    'weak fuzzy name',
    (r) => {
      r.displayName.text = 'Fixture Cafe Airport Branch';
    },
    'no_match',
  ],
  [
    'generic street/address',
    (r) => {
      r.types = [
        'street_address',
        'route',
        'political',
        'administrative_area_level_1',
      ];
    },
    'no_match',
  ],
]) {
  test(`Google rejects ${scenario}`, async () => {
    const changed = clone(row);
    mutate(changed);
    assert.deepEqual(
      await googleFixture({ places: [changed] }).resolve(
        recognition,
        verification,
      ),
      { status: 'unresolved', reason },
    );
  });
}
test('explicit correction conflicts fail closed without lookup; stale workspace never overrides verified city', async () => {
  let requests = 0;
  const provider = googleFixture(undefined, async () => {
    requests++;
    return new Response(JSON.stringify({ places: [row] }));
  });
  assert.deepEqual(
    await provider.resolve(recognition, verification, {
      cityOverride: 'Guangzhou',
    }),
    { status: 'unresolved', reason: 'locality_conflict' },
  );
  assert.equal(requests, 0);
  assert.equal(
    (
      await provider.resolve(recognition, verification, {
        workspaceAreaHint: 'Guangzhou',
      })
    ).status,
    'resolved',
  );
});
test('Chinese native cities and province-level municipalities retain geographic branch protection', async () => {
  const changed = clone(row);
  changed.addressComponents[2] = {
    longText: '上海市',
    shortText: '上海',
    types: ['administrative_area_level_1', 'political'],
  };
  assert.equal(
    (
      await googleFixture({ places: [changed] }).resolve(
        recognition,
        verification,
      )
    ).status,
    'resolved',
  );
  changed.addressComponents[2].longText = '北京市';
  changed.addressComponents[2].shortText = '北京';
  assert.equal(
    (
      await googleFixture({ places: [changed] }).resolve(
        recognition,
        verification,
      )
    ).status,
    'unresolved',
  );
});
test('historic university is a valid destination with API-provided coordinates', async () => {
  const evidence = clone(verification);
  evidence.candidates[0].category = 'university';
  const result = await googleFixture({
    places: [
      { ...row, types: ['university', 'point_of_interest', 'establishment'] },
    ],
  }).resolve(recognition, evidence);
  assert.equal(result.status, 'resolved');
  assert.equal(result.candidate.category, 'university');
});
test('China hierarchy resolves a municipal city above district and a Guangzhou city below province', async () => {
  const municipal = clone(row);
  municipal.addressComponents[2] = {
    longText: '上海市',
    shortText: '上海',
    types: ['administrative_area_level_1'],
  };
  municipal.addressComponents.push({
    longText: 'Changning District',
    types: ['administrative_area_level_2'],
  });
  assert.equal(
    (
      await googleFixture({ places: [municipal] }).resolve(
        recognition,
        verification,
      )
    ).status,
    'resolved',
  );
  const evidence = clone(verification);
  evidence.candidates[0].category = 'university';
  evidence.candidates[0].city = 'Guangzhou';
  evidence.candidates[0].cityAliases = ['广州', '广州市', 'Гуанчжоу'];
  evidence.candidates[0].addressClue = undefined;
  const university = clone(row);
  university.types = ['university', 'point_of_interest'];
  university.formattedAddress = 'Fixture University, Guangzhou, China';
  university.location = { latitude: 23.13, longitude: 113.26 };
  university.addressComponents[2] = {
    longText: '广州市',
    shortText: '广州',
    types: ['administrative_area_level_2'],
  };
  university.addressComponents.push({
    longText: 'Guangdong',
    types: ['administrative_area_level_1'],
  });
  const resolved = await googleFixture({ places: [university] }).resolve(
    recognition,
    evidence,
    { cityOverride: 'Гуанчжоу' },
  );
  assert.equal(resolved.status, 'resolved');
  assert.deepEqual(resolved.candidate.coordinates, {
    ...university.location,
    crs: 'WGS84',
  });
});
test('multiple candidates or a truncated page remain ambiguous; repeated identical IDs dedupe', async () => {
  assert.deepEqual(
    await googleFixture({
      places: [row, { ...row, id: 'fixture-google-place-2' }],
    }).resolve(recognition, verification),
    { status: 'unresolved', reason: 'ambiguous_poi' },
  );
  assert.deepEqual(
    await googleFixture({
      places: [row],
      nextPageToken: 'fixture-next-page',
    }).resolve(recognition, verification),
    { status: 'unresolved', reason: 'ambiguous_poi' },
  );
  assert.equal(
    (
      await googleFixture({ places: [row, row] }).resolve(
        recognition,
        verification,
      )
    ).status,
    'resolved',
  );
});
for (const body of [{}, { places: [] }]) {
  test(`zero Google results remain unresolved: ${JSON.stringify(body)}`, async () =>
    assert.deepEqual(
      await googleFixture(body).resolve(recognition, verification),
      noMatch,
    ));
}
test('uninterpretable top-level response fails with a fixed diagnostic', async () => {
  await assert.rejects(
    googleFixture({ places: 'PRIVATE_PAYLOAD' }).resolve(
      recognition,
      verification,
    ),
    (error) => {
      assert.equal(error.message, 'google_places_top_level_invalid');
      assert.equal(safeDiagnostic(error), error.message);
      assert.equal(String(error).includes(token), false);
      return true;
    },
  );
});
test('invalid JSON and oversized Google body have separate safe diagnostics', async () => {
  for (const [body, code] of [
    ['{INVALID_PRIVATE_BODY', 'google_places_invalid_json'],
    [' '.repeat(8 * 1024 * 1024 + 1), 'google_places_response_too_large'],
  ])
    await assert.rejects(
      googleFixture(undefined, async () => new Response(body)).resolve(
        recognition,
        verification,
      ),
      { message: code },
    );
});
test('consumed credential echoes are skipped; contradictory duplicate identities fail closed', async () => {
  assert.deepEqual(
    await googleFixture({ places: [{ ...row, id: token }] }).resolve(
      recognition,
      verification,
    ),
    noMatch,
  );
  await assert.rejects(
    googleFixture({
      places: [row, { ...row, location: { ...row.location, latitude: 30 } }],
    }).resolve(recognition, verification),
    { message: 'google_places_response_invalid' },
  );
});
test('unusable partial rows may use OSM; omitted optional geography can still resolve', async () => {
  for (const partial of [{ id: row.id }, { ...row, location: undefined }]) {
    const primary = googleFixture({ places: [partial] });
    assert.deepEqual(await primary.resolve(recognition, verification), noMatch);
    let calls = 0;
    await new FallbackPoi(primary, {
      resolve: async () => {
        calls++;
        return noMatch;
      },
    }).resolve(recognition, verification);
    assert.equal(calls, 1);
  }
  assert.equal(
    (
      await googleFixture({
        places: [{ ...row, addressComponents: undefined }],
      }).resolve(recognition, verification)
    ).status,
    'resolved',
  );
});

test('actual timeout/429/5xx paths invoke OSM; actual auth failures never do', async () => {
  for (const response of [429, 500, 503, 'timeout']) {
    let calls = 0;
    const codes = [];
    const primary = googleFixture(undefined, async () => {
      if (response === 'timeout') throw new DOMException(token, 'TimeoutError');
      return new Response(token, { status: response });
    });
    assert.deepEqual(
      await new FallbackPoi(
        primary,
        {
          resolve: async () => {
            calls++;
            return noMatch;
          },
        },
        undefined,
        (code) => codes.push(code),
      ).resolve(recognition, verification),
      noMatch,
    );
    assert.equal(calls, 1);
    assert.deepEqual(codes, ['google_places_fallback_used']);
  }
  for (const status of [401, 403]) {
    await assert.rejects(
      new FallbackPoi(
        googleFixture(undefined, async () => new Response(token, { status })),
        { resolve: async () => assert.fail('auth failures cannot use OSM') },
      ).resolve(recognition, verification),
      { message: 'google_places_auth_failed' },
    );
  }
});

test('final resolution telemetry records fixed provider/success/failure enums without error content', async () => {
  const events = [],
    telemetry = new PipelineTelemetry((event) => events.push(event));
  await new FallbackPoi(
    googleFixture(),
    { resolve: async () => assert.fail('no OSM on Google success') },
    telemetry,
  ).resolve(recognition, verification);
  assert.deepEqual(
    events.map((e) =>
      e.event === 'place_pipeline_stage' ? e.stage : [e.provider, e.result],
    ),
    ['google_places', ['google-places', 'resolved']],
  );
  await assert.rejects(
    new FallbackPoi(
      {
        resolve: async () => {
          throw new Error(token);
        },
      },
      { resolve: async () => noMatch },
      telemetry,
    ).resolve(recognition, verification),
  );
  assert.equal(events.at(-1).result, 'failed');
  assert.equal(JSON.stringify(events).includes(token), false);
});
for (const [status, code] of [
  [401, 'google_places_auth_failed'],
  [403, 'google_places_auth_failed'],
  [400, 'google_places_request_failed'],
  [404, 'google_places_request_failed'],
  [429, 'google_places_transient_failure'],
  [500, 'google_places_transient_failure'],
  [503, 'google_places_transient_failure'],
]) {
  test(`HTTP ${status} never reads/logs upstream error bodies and classifies safely`, async () => {
    const provider = googleFixture(undefined, async () => ({
      status,
      ok: false,
      get body() {
        assert.fail('must not read error body');
      },
    }));
    await assert.rejects(provider.resolve(recognition, verification), {
      message: code,
    });
  });
}
test('timeout allows fallback, unclassified networking/programming errors fail closed', async () => {
  for (const [error, code] of [
    [
      new DOMException('PRIVATE_TIMEOUT', 'TimeoutError'),
      'google_places_transient_failure',
    ],
    [new TypeError(token), 'google_places_request_failed'],
  ]) {
    await assert.rejects(
      googleFixture(undefined, async () => {
        throw error;
      }).resolve(recognition, verification),
      { message: code },
    );
  }
});
test('ADC obtains refreshed short-lived tokens through the auth library and never needs a key', async () => {
  let calls = 0;
  const access = googlePlacesAdc(project, {
    getAccessToken: async () => `${token}-${++calls}`,
  });
  assert.equal(await access(), `${token}-1`);
  assert.equal(await access(), `${token}-2`);
  assert.equal(
    GOOGLE_PLACES_SCOPE,
    'https://www.googleapis.com/auth/maps-platform.places.textsearch',
  );
  for (const auth of [
    { getAccessToken: async () => null },
    {
      getAccessToken: async () => {
        throw new Error(token);
      },
    },
  ]) {
    await assert.rejects(googlePlacesAdc(project, auth)(), {
      message: 'google_places_adc_unavailable',
    });
  }
  await assert.rejects(
    new GooglePlacesPoi(async () => '', project).resolve(
      recognition,
      verification,
    ),
    { message: 'google_places_configuration_invalid' },
  );
  await assert.rejects(
    new GooglePlacesPoi(async () => {
      throw new Error(token);
    }, project).resolve(recognition, verification),
    { message: 'google_places_adc_unavailable' },
  );
  assert.throws(() => new GooglePlacesPoi(async () => token, token + '/bad'), {
    message: 'google_places_configuration_invalid',
  });
});
test('composed Google success avoids OSM; no-match and ambiguity use fallback without guessing', async () => {
  let calls = 0;
  const fallback = {
    resolve: async () => {
      calls++;
      return noMatch;
    },
  };
  const success = await new FallbackPoi(googleFixture(), fallback).resolve(
    recognition,
    verification,
  );
  assert.equal(success.status, 'resolved');
  assert.equal(calls, 0);
  await new FallbackPoi(googleFixture({ places: [] }), fallback).resolve(
    recognition,
    verification,
  );
  assert.equal(calls, 1);
  const ambiguous = new FallbackPoi(
    googleFixture({ places: [row, { ...row, id: 'fixture-google-place-2' }] }),
    fallback,
  );
  assert.deepEqual(await ambiguous.resolve(recognition, verification), {
    status: 'unresolved',
    reason: 'ambiguous_poi',
  });
  assert.equal(calls, 2);
  const osmCandidate = {
    ...success.candidate,
    providerIdentity: { provider: 'nominatim', id: 'node/123' },
  };
  assert.equal(
    (
      await new FallbackPoi(googleFixture({ places: [] }), {
        resolve: async () => ({ status: 'resolved', candidate: osmCandidate }),
      }).resolve(recognition, verification)
    ).candidate.providerIdentity.provider,
    'nominatim',
  );
});
test('transient fallback logs only the fixed code; auth/config/schema/programming failures remain visible', async () => {
  let calls = 0;
  const logs = [];
  const fallback = {
    resolve: async () => {
      calls++;
      return noMatch;
    },
  };
  const transient = new FallbackPoi(
    googleFixture(undefined, async () => new Response(token, { status: 429 })),
    fallback,
    undefined,
    (code) => logs.push(code),
  );
  assert.deepEqual(await transient.resolve(recognition, verification), noMatch);
  assert.equal(calls, 1);
  assert.deepEqual(logs, ['google_places_fallback_used']);
  for (const error of [
    new GooglePlacesFailure('google_places_auth_failed'),
    new GooglePlacesFailure('google_places_adc_unavailable'),
    new GooglePlacesFailure('google_places_configuration_invalid'),
    new GooglePlacesFailure('google_places_response_invalid'),
    new Error(token),
  ]) {
    await assert.rejects(
      new FallbackPoi(
        {
          resolve: async () => {
            throw error;
          },
        },
        fallback,
      ).resolve(recognition, verification),
      error,
    );
  }
  assert.equal(calls, 1);
});
test('structured pipeline telemetry contains only fixed enums, status and bounded duration', async () => {
  const events = [];
  let clock = 10;
  const telemetry = new PipelineTelemetry(
    (event) => events.push(event),
    () => (clock += 5),
  );
  for (const stage of ['image_download', 'vision', 'web_verification'])
    await telemetry.measure(stage, async () => ({
      privateText: token,
      image: 'PRIVATE_IMAGE',
      city: 'PRIVATE_CITY',
    }));
  const fallback = new FallbackPoi(
    googleFixture({ places: [] }),
    { resolve: async () => noMatch },
    telemetry,
  );
  await fallback.resolve(recognition, verification);
  await assert.rejects(
    telemetry.measure('vision', async () => {
      throw new Error(token);
    }),
  );
  for (const event of events) {
    assert.ok(
      Number.isInteger(event.durationMs) &&
        event.durationMs >= 0 &&
        event.durationMs <= 300_000,
    );
    assert.deepEqual(
      Object.keys(event).sort(),
      event.event === 'place_pipeline_stage'
        ? ['durationMs', 'event', 'stage', 'status']
        : ['durationMs', 'event', 'provider', 'result'],
    );
  }
  const serialized = JSON.stringify(events);
  for (const forbidden of [
    token,
    'PRIVATE_IMAGE',
    'PRIVATE_CITY',
    recognition.visibleText[0],
    row.displayName.text,
    row.formattedAddress,
    String(row.location.latitude),
  ])
    assert.equal(serialized.includes(forbidden), false);
  assert.deepEqual(
    events
      .filter((e) => e.event === 'place_pipeline_stage')
      .map((e) => e.stage),
    [
      'image_download',
      'vision',
      'web_verification',
      'google_places',
      'nominatim',
      'vision',
    ],
  );
  assert.equal(
    events.find((e) => e.event === 'place_resolution').result,
    'unresolved',
  );
  const before = events.length;
  await telemetry.measure(token, async () => 'ok');
  assert.equal(events.length, before);
});

for (const [clue, address] of [
  ['No. 158 Anfu Road', '158 Anfu Rd'],
  ['158 Anfu Rd', 'No. 158 Anfu Road'],
  ['№ 158 Anfu Road', '158 Anfu Rd'],
  ['158 Anfu Road', '№ 158 Anfu Rd'],
  ['No. 158 Anfu Street', '158 Anfu St'],
  ['158 Anfu Avenue', '№ 158 Anfu Ave'],
  ['No. 158 Anfu Boulevard', '158 Anfu Blvd'],
  ['№ 158 Anfu Lane', '158 Anfu Ln'],
]) {
  test(`bounded house-number and street normalization: ${clue} / ${address}`, async () => {
    const evidence = clone(verification);
    evidence.candidates[0].addressClue = clue;
    const place = {
      ...row,
      formattedAddress: address + ', Shanghai, China',
      addressComponents: row.addressComponents.map((c) =>
        c.types.includes('street_number')
          ? { ...c, longText: '158', shortText: '158' }
          : c,
      ),
    };
    assert.equal(
      (await googleFixture({ places: [place] }).resolve(recognition, evidence))
        .status,
      'resolved',
    );
    for (const bad of [
      {
        ...place,
        formattedAddress: address.replace('158', '1580') + ', Shanghai',
      },
      {
        ...place,
        formattedAddress: address.replace('158', '159') + ', Shanghai',
      },
      { ...place, displayName: { text: 'Other Cafe' } },
      {
        ...place,
        addressComponents: place.addressComponents.map((c) =>
          c.types.includes('locality')
            ? { ...c, longText: 'Guangzhou', shortText: 'Guangzhou' }
            : c,
        ),
      },
      {
        ...place,
        addressComponents: place.addressComponents.map((c) =>
          c.types.includes('country') ? { ...c, shortText: 'JP' } : c,
        ),
      },
    ])
      assert.notEqual(
        (await googleFixture({ places: [bad] }).resolve(recognition, evidence))
          .status,
        'resolved',
      );
  });
}

test('Google Place ID refresh retrieves a bounded live view using ADC and no search/user content', async () => {
  const provider = googleFixture(undefined, async (url, init) => {
    assert.equal(url, 'https://places.googleapis.com/v1/places/' + row.id);
    assert.equal(init.method, 'GET');
    assert.equal(init.body, undefined);
    assert.equal(init.headers.Authorization, 'Bearer ' + token);
    assert.equal(init.headers['X-Goog-User-Project'], project);
    assert.equal(
      init.headers['X-Goog-FieldMask'],
      'id,displayName,formattedAddress,location,attributions',
    );
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    return new Response(
      JSON.stringify({ ...row, location: { latitude: 30, longitude: 120 } }),
    );
  });
  const fallback = {
    resolve: async () =>
      assert.fail('A stored Google ID cannot be refreshed by substituting OSM'),
  };
  const view = await new FallbackPoi(provider, fallback).refresh({
    provider: 'google-places',
    id: row.id,
  });
  assert.deepEqual(view.coordinates, {
    latitude: 30,
    longitude: 120,
    crs: 'WGS84',
  });
  assert.equal(view.address.formatted, row.formattedAddress);
  assert.deepEqual(view.attributions, row.attributions);
  assert.equal(view.providerIdentity.id, row.id);
  assert.equal(view.references[0].observedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(
    GOOGLE_PLACES_DETAILS_SCOPE,
    'https://www.googleapis.com/auth/maps-platform.places.details',
  );
});

test('refresh validates complete identity and response identity; unsafe or incomplete provider content fails closed', async () => {
  for (const identity of [
    { provider: 'nominatim', id: row.id },
    { provider: 'google-places', id: 123 },
    { provider: 'google-places', id: '' },
  ])
    await assert.rejects(
      googleFixture(undefined, async () =>
        assert.fail('invalid ID must not request'),
      ).refresh(identity),
      { message: 'google_places_request_failed' },
    );
  for (const body of [
    { ...row, id: 'different-id' },
    { ...row, location: undefined },
    { ...row, displayName: undefined },
    { ...row, location: { latitude: 1000, longitude: 120 } },
    { ...row, displayName: { text: token } },
  ])
    await assert.rejects(
      googleFixture(body).refresh({ provider: 'google-places', id: row.id }),
      { message: 'google_places_response_invalid' },
    );
});

for (const [status, code] of [
  [401, 'auth_failed'],
  [403, 'auth_failed'],
  [404, 'request_failed'],
  [429, 'transient_failure'],
  [503, 'transient_failure'],
]) {
  test(`refresh HTTP ${status} remains a safe error without silently replacing stored identity`, async () => {
    const provider = googleFixture(undefined, async () => ({
      status,
      ok: false,
      get body() {
        assert.fail('never read upstream error content');
      },
    }));
    await assert.rejects(
      new FallbackPoi(provider, {
        resolve: async () => assert.fail('no fallback on identity refresh'),
      }).refresh({ provider: 'google-places', id: row.id }),
      { message: 'google_places_' + code },
    );
  });
}
