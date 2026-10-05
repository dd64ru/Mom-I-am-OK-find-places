import { z } from 'zod';
import { GoogleAuth } from 'google-auth-library';
import type { PoiProvider } from '@places/core';
import {
  CandidateSchema,
  GoogleIdentitySchema,
  PlaceDisplaySchema,
  type PlaceDisplay,
  RecognitionSchema,
  VerificationSchema,
  GeographicContextSchema,
  type Recognition,
  type Verification,
  type GeographicContext,
  type PoiResolution,
  type Candidate,
} from '@places/schemas';
import {
  selectLocality,
  normalizedLocality,
  type Locality,
} from './locality.js';
export const GOOGLE_PLACES_ENDPOINT =
  'https://places.googleapis.com/v1/places:searchText';
export const GOOGLE_PLACES_FIELD_MASK =
  'places.id,places.displayName,places.formattedAddress,places.location,places.types,places.addressComponents,places.attributions,nextPageToken';
type FailureCode =
  | 'google_places_adc_unavailable'
  | 'google_places_configuration_invalid'
  | 'google_places_auth_failed'
  | 'google_places_request_failed'
  | 'google_places_response_invalid'
  | 'google_places_transient_failure';
export class GooglePlacesFailure extends Error {
  constructor(readonly code: FailureCode) {
    super(code);
    this.name = 'GooglePlacesFailure';
  }
}
const text = z.string().min(1).max(300);
const Component = z
  .object({
    longText: text,
    shortText: text.optional(),
    types: z.array(z.string().max(100)).min(1).max(10),
    languageCode: z.string().max(20).optional(),
  })
  .strict();
const Row = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    displayName: z
      .object({ text, languageCode: z.string().max(20).optional() })
      .strict()
      .optional(),
    formattedAddress: z.string().min(1).max(1000).optional(),
    location: z
      .object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
      })
      .strict()
      .optional(),
    types: z
      .array(z.string().regex(/^[a-z0-9_]{1,100}$/))
      .max(30)
      .default([]),
    addressComponents: z.array(Component).max(30).default([]),
    attributions: z
      .array(
        z
          .object({
            provider: text,
            providerUri: z
              .string()
              .url()
              .max(1000)
              .refine((s) => new URL(s).protocol === 'https:'),
          })
          .strict(),
      )
      .max(10)
      .optional(),
  })
  .strict();
const ResponseSchema = z
  .object({
    places: z.array(Row).max(10).default([]),
    nextPageToken: z.string().min(1).max(3000).optional(),
  })
  .strict();
// Equality after script/diacritic/punctuation normalization, never edit-distance/ranking/substring venue matching.
export const normalizedVenueName = (value: string) =>
  value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
const travelTypes = new Set([
  'restaurant',
  'cafe',
  'coffee_shop',
  'bakery',
  'bar',
  'pub',
  'food_court',
  'store',
  'shopping_mall',
  'market',
  'supermarket',
  'university',
  'library',
  'museum',
  'historical_place',
  'historical_landmark',
  'cultural_landmark',
  'monument',
  'tourist_attraction',
  'park',
  'national_park',
  'beach',
  'botanical_garden',
  'zoo',
  'aquarium',
  'art_gallery',
  'observation_deck',
  'hiking_area',
  'waterfall',
  'island',
  'church',
  'hindu_temple',
  'mosque',
  'synagogue',
  'amusement_park',
  'garden',
]);
const travelType = (types: string[]) =>
  types.find(
    (t) =>
      travelTypes.has(t) || t.endsWith('_restaurant') || t.endsWith('_store'),
  );
function geographicMatch(
  row: z.infer<typeof Row>,
  locality: Locality,
): { city: string; countryCode: string } | undefined {
  const components = row.addressComponents;
  const countries = components.filter((c) => c.types.includes('country'));
  if (
    countries.length !== 1 ||
    !/^[A-Z]{2}$/.test(countries[0]?.shortText ?? '')
  )
    return;
  const countryCode = countries[0]!.shortText!;
  if (locality.countryCode && locality.countryCode !== countryCode) return;
  let cities = components.filter(
    (c) => c.types.includes('locality') || c.types.includes('postal_town'),
  );
  if (!cities.length && countryCode === 'CN') {
    cities = components.filter(
      (c) =>
        c.types.includes('administrative_area_level_1') &&
        [c.longText, c.shortText].some(
          (s) =>
            s &&
            [
              'shanghai',
              'beijing',
              'tianjin',
              'chongqing',
              '上海',
              '北京',
              '天津',
              '重庆',
            ].includes(normalizedLocality(s)),
        ),
    );
  }
  // In province-level municipalities level_2 may be a district, not another city.
  if (!cities.length && countryCode === 'CN')
    cities = components.filter((c) =>
      c.types.includes('administrative_area_level_2'),
    );
  if (!cities.length) return;
  const matches = (c: z.infer<typeof Component>) =>
    [c.longText, c.shortText].some(
      (s) =>
        s &&
        locality.aliases.some(
          (a) => normalizedLocality(a) === normalizedLocality(s),
        ),
    );
  // Reject a contradictory locality component, even if another component matches the requested city.
  if (!cities.every(matches)) return;
  return { city: locality.name, countryCode };
}
const normalizedAddress = (value: string) =>
  value
    .replace(/№(?=\s*\d)/gu, ' ')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\bno\.?\s*(?=\d)/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(
      /\b(?:rd|st|ave|blvd|ln)\b/gu,
      (word) =>
        ({
          rd: 'road',
          st: 'street',
          ave: 'avenue',
          blvd: 'boulevard',
          ln: 'lane',
        })[word]!,
    );
function addressMatches(clue: string | undefined, row: z.infer<typeof Row>) {
  if (!row.formattedAddress) return false;
  if (!clue) return true;
  const wanted = normalizedAddress(clue);
  if (wanted.length < 4) return false;
  return [
    ` ${normalizedAddress(row.formattedAddress)} `,
    ...row.addressComponents.flatMap((c) =>
      [c.longText, c.shortText]
        .filter((s): s is string => !!s)
        .map((s) => ` ${normalizedAddress(s)} `),
    ),
  ].some((s) => s.includes(` ${wanted} `));
}
export class GooglePlacesPoi implements PoiProvider {
  constructor(
    private readonly accessToken: () => Promise<string>,
    private readonly quotaProject: string,
    private readonly request: typeof fetch = fetch,
    private readonly now = Date.now,
  ) {
    if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(quotaProject))
      throw new GooglePlacesFailure('google_places_configuration_invalid');
  }
  private async load<S extends z.ZodTypeAny>(
    endpoint: string,
    init: { method: 'POST' | 'GET'; fieldMask: string; body?: string },
    schema: S,
  ): Promise<z.output<S>> {
    let token: string;
    try {
      token = await this.accessToken();
    } catch {
      throw new GooglePlacesFailure('google_places_adc_unavailable');
    }
    if (
      typeof token !== 'string' ||
      token.length > 4096 ||
      !/^[A-Za-z0-9._~+/-]+=*$/.test(token)
    )
      throw new GooglePlacesFailure('google_places_configuration_invalid');
    const signal = AbortSignal.timeout(10_000);
    let response: Response;
    try {
      response = await this.request(endpoint, {
        method: init.method,
        redirect: 'error',
        signal,
        headers: {
          Authorization: 'Bearer ' + token,
          'X-Goog-User-Project': this.quotaProject,
          'X-Goog-FieldMask': init.fieldMask,
          'Content-Type': 'application/json',
        },
        ...(init.body ? { body: init.body } : {}),
      });
    } catch (error) {
      if (
        signal.aborted ||
        (error instanceof DOMException &&
          ['TimeoutError', 'AbortError'].includes(error.name))
      )
        throw new GooglePlacesFailure('google_places_transient_failure');
      throw new GooglePlacesFailure('google_places_request_failed');
    }
    // Never read an error body, which may echo keys or user/provider text.
    if (response.status === 401 || response.status === 403)
      throw new GooglePlacesFailure('google_places_auth_failed');
    if (
      response.status === 429 ||
      (response.status >= 500 && response.status <= 599)
    )
      throw new GooglePlacesFailure('google_places_transient_failure');
    if (!response.ok)
      throw new GooglePlacesFailure('google_places_request_failed');
    let data: z.output<S>;
    try {
      if (!response.body) throw new Error();
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 200_000) throw new Error();
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      data = schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      // An unexpected upstream echo must never reach persisted IDs/attributions or Telegram URLs.
      if (JSON.stringify(data).includes(token)) throw new Error();
    } catch {
      throw new GooglePlacesFailure(
        signal.aborted
          ? 'google_places_transient_failure'
          : 'google_places_response_invalid',
      );
    }
    return data;
  }
  // Refresh is a read-only, transient provider view. Callers must not save it as a Place.
  async refresh(identity: {
    provider: string;
    id: string;
  }): Promise<PlaceDisplay> {
    const parsed = GoogleIdentitySchema.safeParse(identity);
    if (!parsed.success)
      throw new GooglePlacesFailure('google_places_request_failed');
    const row = await this.load(
      'https://places.googleapis.com/v1/places/' +
        encodeURIComponent(parsed.data.id),
      {
        method: 'GET',
        fieldMask: 'id,displayName,formattedAddress,location,attributions',
      },
      Row,
    );
    if (
      row.id !== parsed.data.id ||
      !row.displayName ||
      !row.location ||
      !row.formattedAddress
    )
      throw new GooglePlacesFailure('google_places_response_invalid');
    return PlaceDisplaySchema.parse({
      canonicalName: row.displayName.text,
      coordinates: { ...row.location, crs: 'WGS84' },
      address: { formatted: row.formattedAddress },
      providerIdentity: parsed.data,
      references: [
        {
          provider: 'google-places',
          externalId: row.id,
          url: `https://www.google.com/maps/search/?api=1&query=Google%20Place&query_place_id=${encodeURIComponent(row.id)}`,
          observedAt: new Date(this.now()).toISOString(),
        },
      ],
      ...(row.attributions?.length ? { attributions: row.attributions } : {}),
    });
  }

  async resolve(
    recognition: Recognition,
    verification: Verification,
    context: GeographicContext = {},
  ): Promise<PoiResolution> {
    const input = z
      .object({
        recognition: RecognitionSchema,
        verification: VerificationSchema,
        context: GeographicContextSchema,
      })
      .safeParse({ recognition, verification, context });
    if (!input.success)
      throw new GooglePlacesFailure('google_places_request_failed');
    const decision = selectLocality(
      input.data.recognition,
      input.data.verification,
      input.data.context,
    );
    if (decision.status !== 'ready') return decision;
    const { clue, locality } = decision;
    const name = 'canonicalName' in clue ? clue.canonicalName : clue.name;
    const addressClue = 'addressClue' in clue ? clue.addressClue : undefined;
    const query = [
      clue.nativeName?.slice(0, 300) ?? name.slice(0, 300),
      locality.name,
      addressClue,
      locality.countryCode,
    ]
      .filter(Boolean)
      .join(', ')
      .slice(0, 800);
    const data = await this.load(
      GOOGLE_PLACES_ENDPOINT,
      {
        method: 'POST',
        fieldMask: GOOGLE_PLACES_FIELD_MASK,
        body: JSON.stringify({
          textQuery: query,
          languageCode: 'en',
          pageSize: 10,
          includePureServiceAreaBusinesses: false,
          ...(locality.countryCode ? { regionCode: locality.countryCode } : {}),
        }),
      },
      ResponseSchema,
    );
    const aliases = [name, clue.nativeName, ...clue.aliases]
      .filter((s): s is string => !!s)
      .slice(0, 12)
      .map((s) => normalizedVenueName(s.slice(0, 300)))
      .filter((s) => s.length >= 4 || /\p{Script=Han}/u.test(s));
    const candidates = new Map<string, Candidate>();
    let nameMatched = false,
      categoryMatched = false,
      geographyMatched = false;
    for (const row of data.places) {
      if (!row.displayName || !row.location || !row.formattedAddress) continue;
      if (!aliases.includes(normalizedVenueName(row.displayName.text)))
        continue;
      nameMatched = true;
      const category = travelType(row.types);
      if (!category) continue;
      categoryMatched = true;
      const address = geographicMatch(row, locality);
      if (!address) continue;
      geographyMatched = true;
      if (!addressMatches(addressClue, row)) continue;
      const reference = {
        provider: 'google-places',
        externalId: row.id,
        url: `https://www.google.com/maps/search/?api=1&query=Google%20Place&query_place_id=${encodeURIComponent(row.id)}`,
        observedAt: new Date(this.now()).toISOString(),
      };
      const parsedCandidate = CandidateSchema.safeParse({
        canonicalName: row.displayName.text,
        ...(clue.nativeName
          ? { nativeName: clue.nativeName.slice(0, 300) }
          : {}),
        aliases: clue.aliases.slice(0, 10).map((s) => s.slice(0, 300)),
        category,
        // Google's Place.location LatLng contract specifies WGS84; no China-specific offsets.
        coordinates: { ...row.location, crs: 'WGS84' },
        address: { formatted: row.formattedAddress, ...address },
        references: [...input.data.verification.references, reference],
        confidence: clue.confidence,
        resolution: 'deterministic_poi',
        providerIdentity: { provider: 'google-places', id: row.id },
        ...(row.attributions?.length ? { attributions: row.attributions } : {}),
      });
      if (!parsedCandidate.success)
        throw new GooglePlacesFailure('google_places_response_invalid');
      const previous = candidates.get(row.id);
      if (
        previous &&
        (previous.coordinates.latitude !== row.location.latitude ||
          previous.coordinates.longitude !== row.location.longitude)
      )
        throw new GooglePlacesFailure('google_places_response_invalid');
      candidates.set(row.id, parsedCandidate.data);
    }
    if (candidates.size > 1 || (candidates.size && data.nextPageToken))
      return { status: 'unresolved', reason: 'ambiguous_poi' };
    if (candidates.size === 1)
      return { status: 'resolved', candidate: [...candidates.values()][0]! };
    if (geographyMatched) return { status: 'unresolved', reason: 'no_match' };
    if (categoryMatched)
      return locality.source === 'vision'
        ? { status: 'city_unknown', reason: 'ambiguous_locality' }
        : { status: 'unresolved', reason: 'locality_mismatch' };
    return {
      status: 'unresolved',
      reason: nameMatched ? 'unsupported_category' : 'no_match',
    };
  }
}

export const GOOGLE_PLACES_SCOPE =
  'https://www.googleapis.com/auth/maps-platform.places.textsearch';
export const GOOGLE_PLACES_DETAILS_SCOPE =
  'https://www.googleapis.com/auth/maps-platform.places.details';
export function googlePlacesAdc(
  projectId: string,
  auth: Pick<GoogleAuth, 'getAccessToken'> = new GoogleAuth({
    projectId,
    scopes: [GOOGLE_PLACES_SCOPE, GOOGLE_PLACES_DETAILS_SCOPE],
  }),
): () => Promise<string> {
  return async () => {
    try {
      const token = await auth.getAccessToken();
      if (!token) throw new Error();
      return token;
    } catch {
      throw new GooglePlacesFailure('google_places_adc_unavailable');
    }
  };
}
