import { createHash, timingSafeEqual } from 'node:crypto';
import {
  MAX_PROJECTION_PLACES,
  PROJECTION_CONTENT_TYPES,
  ProjectionService,
  bounded,
  serializeProjection,
  type ProjectionFormat,
  type ProjectionCounts,
} from '@places/core';
import { type Place } from '@places/schemas';
export type FeedRequest = {
  method: string;
  query: Record<string, unknown>;
  authorization?: string;
  ifNoneMatch?: string;
};
export type FeedResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};
export type FeedEvent = ProjectionCounts & {
  event: 'projection_request';
  format: ProjectionFormat;
  truncated: boolean;
};
// The feed receives only read ports. No repository, transaction or write dependency.
export type FeedDependencies = {
  allowUrlToken?: boolean;
  tokenDigest(): Promise<string>;
  readPlaces(limit: number): Promise<{ places: Place[]; truncated: boolean }>;
  projection: ProjectionService;
  diagnostic?: (event: FeedEvent) => void;
};
const headers = {
  'Cache-Control': 'private, no-cache, max-age=0, must-revalidate',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};
const failure = (
  status: number,
  body: string,
  extra: Record<string, string> = {},
): FeedResponse => ({
  status,
  body,
  headers: {
    ...headers,
    'Content-Type': 'text/plain; charset=utf-8',
    ...extra,
  },
});
export function validFeedToken(token: unknown, digest: string): boolean {
  if (
    typeof token !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/u.test(token) ||
    !/^[a-f0-9]{64}$/u.test(digest)
  )
    return false;
  const bytes = Buffer.from(token, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== token)
    return false;
  const actual = createHash('sha256').update(token, 'utf8').digest();
  return timingSafeEqual(actual, Buffer.from(digest, 'hex'));
}
export const projectionEtag = (body: string) =>
  '"' + createHash('sha256').update(body).digest('hex') + '"';
const matchesEtag = (value: string | undefined, etag: string) =>
  !!value &&
  value.length <= 1024 &&
  value
    .split(',')
    .some(
      (part) =>
        part.trim() === '*' || part.trim().replace(/^W\//u, '') === etag,
    );
export async function handleFeed(
  request: FeedRequest,
  deps: FeedDependencies,
): Promise<FeedResponse> {
  if (request.method !== 'GET')
    return failure(405, 'method_not_allowed', { Allow: 'GET' });
  try {
    // A latest-version hash is read on each request: rotation does not wait for a cold start.
    const digest = await bounded(deps.tokenDigest(), 5_000);
    if (!/^[a-f0-9]{64}$/u.test(digest))
      return failure(503, 'feed_unavailable');
    const bearer = request.authorization?.match(
      /^Bearer ([A-Za-z0-9_-]{43})$/u,
    )?.[1];
    const queryToken = request.query.token;
    if (queryToken !== undefined && !deps.allowUrlToken)
      return failure(401, 'unauthorized');
    if (request.authorization && !bearer) return failure(401, 'unauthorized');
    if (queryToken !== undefined && typeof queryToken !== 'string')
      return failure(401, 'unauthorized');
    if (bearer && queryToken !== undefined && bearer !== queryToken)
      return failure(401, 'unauthorized');
    if (!validFeedToken(bearer ?? queryToken, digest))
      return failure(401, 'unauthorized');
    if (
      Object.keys(request.query).some(
        (key) => !['token', 'format'].includes(key),
      )
    )
      return failure(400, 'invalid_feed_request');
    const format = request.query.format ?? 'geojson';
    if (
      typeof format !== 'string' ||
      !['geojson', 'gpx', 'kml'].includes(format)
    )
      return failure(400, 'unsupported_format');
    const selected = format as ProjectionFormat;
    const source = await bounded(
      deps.readPlaces(MAX_PROJECTION_PLACES),
      10_000,
    );
    // Do not silently return an incomplete export when a workspace exceeds the initial bound.
    if (source.truncated || source.places.length > MAX_PROJECTION_PLACES)
      return failure(503, 'feed_limit_exceeded');
    const { places, counts } = await deps.projection.project(source.places);
    const body = serializeProjection(selected, places);
    const etag = projectionEtag(body);
    try {
      deps.diagnostic?.({
        event: 'projection_request',
        format: selected,
        ...counts,
        truncated: false,
      });
    } catch {
      /* best effort */
    }
    return {
      status: matchesEtag(request.ifNoneMatch, etag) ? 304 : 200,
      headers: {
        ...headers,
        'Content-Type': PROJECTION_CONTENT_TYPES[selected] + '; charset=utf-8',
        ETag: etag,
      },
      body: matchesEtag(request.ifNoneMatch, etag) ? '' : body,
    };
  } catch {
    return failure(503, 'feed_unavailable');
  }
}
