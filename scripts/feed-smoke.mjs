import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const fail = () => {
  throw new Error('feed_smoke_failed');
};
function snapshotHeaders(headers) {
  if (headers.get('x-places-feed-version') !== '1') fail();
  const count = (name) => {
    const value = headers.get(name);
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(value ?? '') || Number(value) > 100)
      fail();
    return Number(value);
  };
  const total = count('x-places-total');
  const projected = count('x-places-projected');
  const complete = headers.get('x-places-snapshot-complete');
  if (
    !['true', 'false'].includes(complete) ||
    projected > total ||
    (complete === 'true' && projected !== total)
  )
    fail();
  return { total, projected, complete: complete === 'true' };
}
export function validateFeedGeojson(body) {
  if (
    !body ||
    typeof body !== 'object' ||
    body.type !== 'FeatureCollection' ||
    !Array.isArray(body.features) ||
    body.features.length > 100 ||
    'crs' in body
  )
    fail();
  const ids = new Set();
  for (const feature of body.features) {
    const point = feature?.geometry;
    const props = feature?.properties;
    if (
      feature?.type !== 'Feature' ||
      typeof feature.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(feature.id) ||
      ids.has(feature.id)
    )
      fail();
    ids.add(feature.id);
    const coords = point?.coordinates;
    if (
      point?.type !== 'Point' ||
      !Array.isArray(coords) ||
      coords.length !== 2 ||
      coords.some((n) => typeof n !== 'number' || !Number.isFinite(n)) ||
      Math.abs(coords[0]) > 180 ||
      Math.abs(coords[1]) > 90
    )
      fail();
    if (
      !props ||
      typeof props.label !== 'string' ||
      !props.label.trim() ||
      !Array.isArray(props.tags) ||
      props.tags.some((tag) => typeof tag !== 'string') ||
      !['google-places', 'nominatim', 'osm'].includes(props.provider)
    )
      fail();
    if (
      Object.keys(props).some(
        (key) =>
          ![
            'label',
            'tags',
            'provider',
            'category',
            'sourceLink',
            'attribution',
          ].includes(key),
      )
    )
      fail();
    if (
      props.provider === 'google-places' &&
      ['category', 'sourceLink', 'attribution'].some((key) => key in props)
    )
      fail();
  }
  return body.features.length;
}
async function boundedJson(response) {
  if (!response.body) fail();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2_000_000) fail();
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
  }
}
// Read-only owner utility. All failures and returned results are content-free.
export async function smokeFeed({ url, token, fetchImpl = fetch }) {
  try {
    const endpoint = new URL(url);
    if (
      endpoint.protocol !== 'https:' ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      !/^[A-Za-z0-9_-]{43}$/.test(token ?? '') ||
      Buffer.from(token, 'base64url').toString('base64url') !== token
    )
      fail();
    const request = (format = 'geojson', options = {}) => {
      const target = new URL(endpoint);
      target.searchParams.set('format', format);
      return fetchImpl(target, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(60_000),
        ...options,
      });
    };
    const first = await request();
    if (
      first.status !== 200 ||
      first.headers.get('content-type')?.toLowerCase() !==
        'application/geo+json; charset=utf-8'
    )
      fail();
    const metadata = snapshotHeaders(first.headers);
    const count = validateFeedGeojson(await boundedJson(first));
    if (metadata.projected !== count) fail();
    const etag = first.headers.get('etag');
    if (!/^"[a-f0-9]{64}"$/.test(etag ?? '')) fail();
    const second = await request('geojson', {
      headers: { Authorization: `Bearer ${token}`, 'If-None-Match': etag },
    });
    if (second.status !== 304 || second.headers.get('etag') !== etag) fail();
    const current = snapshotHeaders(second.headers);
    if (current.projected !== count) fail();
    for (const [format, options, status] of [
      ['geojson', { headers: {} }, 401],
      ['geojson', { headers: { Authorization: 'Bearer malformed' } }, 401],
      ['unsupported', {}, 400],
      ['geojson', { method: 'POST' }, 405],
    ]) {
      const result = await request(format, options);
      const actual = result.status;
      await result.body?.cancel();
      if (actual !== status) fail();
    }
    return {
      event: 'feed_smoke',
      featureCount: count,
      ...current,
      etagSuccess: true,
    };
  } catch {
    throw new Error('feed_smoke_failed');
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    console.log(
      JSON.stringify(
        await smokeFeed({
          url: process.env.PLACES_FEED_URL,
          token: process.env.PLACES_FEED_TOKEN,
        }),
      ),
    );
  } catch {
    console.error('feed_smoke_failed');
    process.exitCode = 1;
  }
}
