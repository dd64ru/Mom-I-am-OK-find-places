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
import {
  venueNameScore,
  nameTokens,
  categorySupport,
  GOOGLE_MATCH_THRESHOLD,
  GOOGLE_MATCH_MARGIN,
} from './place-matching.js';
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
export const normalizedAddress = (value: string) =>
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
function addressSignal(
  clue: string | undefined,
  row: z.infer<typeof Row>,
): 'match' | 'absent' | 'conflict' {
  if (!clue) return 'absent';
  const wanted = normalizedAddress(clue);
  if (wanted.length < 4) return 'absent';
  const number = wanted.match(/^([0-9]+[a-z]?)\b/u)?.[1];
  const returnedNumbers = [
    normalizedAddress(row.formattedAddress ?? '').match(
      /^([0-9]+[a-z]?)\b/u,
    )?.[1],
    ...row.addressComponents
      .filter((c) => c.types.includes('street_number'))
      .map((c) => normalizedAddress(c.longText)),
  ].filter(Boolean);
  if (number && returnedNumbers.some((n) => n !== number)) return 'conflict';
  const values = [
    row.formattedAddress ?? '',
    ...row.addressComponents.flatMap((c) => [c.longText, c.shortText ?? '']),
  ].map(normalizedAddress);
  if (values.some((s) => ` ${s} `.includes(` ${wanted} `))) return 'match';
  return number && returnedNumbers.length ? 'conflict' : 'absent';
}
export type GoogleFilterEvent = {
  event: 'google_places_filter';
  query: number;
  returned: number;
  complete: number;
  nameStrong: number;
  categoryCompatible: number;
  localityCompatible: number;
  addressCompatible: number;
  accepted: number;
  result: 'resolved' | 'ambiguous' | 'no_match';
  rejected: {
    no_name_match: number;
    category_conflict: number;
    country_conflict: number;
    locality_conflict: number;
    address_conflict: number;
    below_threshold: number;
    ambiguous_score: number;
  };
};
export class GooglePlacesPoi implements PoiProvider {
  constructor(
    private readonly accessToken: () => Promise<string>,
    private readonly quotaProject: string,
    private readonly request: typeof fetch = fetch,
    private readonly now = Date.now,
    private readonly diagnostic: (event: GoogleFilterEvent) => void = () => {},
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
      true,
    );
    if (decision.status !== 'ready') return decision;
    const { clue, locality } = decision;
    const name = 'canonicalName' in clue ? clue.canonicalName : clue.name;
    const additional =
      input.data.verification.status === 'verified' &&
      input.data.verification.references.length
        ? input.data.verification.candidates.filter(
            (c) =>
              c.confidence >= 0.8 &&
              (!locality.countryCode ||
                !c.countryCode ||
                c.countryCode === locality.countryCode) &&
              (!c.city ||
                locality.aliases.some(
                  (a) => normalizedLocality(a) === normalizedLocality(c.city!),
                )),
          )
        : input.data.recognition.clues.filter((c) => c.confidence >= 0.85);
    const boundedClues = additional.slice(0, 3);
    const otherClue = boundedClues.find(
      (c) => ('canonicalName' in c ? c.canonicalName : c.name) !== name,
    );
    const otherName = otherClue
      ? 'canonicalName' in otherClue
        ? otherClue.canonicalName
        : otherClue.name
      : undefined;
    const reordered = nameTokens(name).reverse().join(' ');
    const partial = [...nameTokens(name)].sort(
      (a, b) => b.length - a.length,
    )[0];
    const variantNames = [
      clue.nativeName ?? name,
      clue.nativeName && clue.nativeName !== name
        ? name
        : (clue.aliases[0] ?? reordered),
      otherName ?? clue.aliases[1] ?? partial,
    ].filter((s): s is string => !!s);
    const queries = [
      ...new Set(
        variantNames.map((n) => {
          const owner =
            boundedClues.find((c) =>
              [
                'canonicalName' in c ? c.canonicalName : c.name,
                c.nativeName,
                ...c.aliases,
              ].includes(n),
            ) ?? clue;
          const variantAddress =
            'addressClue' in owner ? owner.addressClue : undefined;
          return [
            n.slice(0, 300),
            locality.name,
            variantAddress,
            locality.countryCode,
          ]
            .filter(Boolean)
            .join(', ')
            .slice(0, 800);
        }),
      ),
    ].slice(0, 3);
    const candidates = new Map<
      string,
      { candidate: Candidate; score: number }
    >();
    let nameMatched = false,
      categoryMatched = false,
      geographyMatched = false,
      truncated = false;
    for (const [queryIndex, query] of queries.entries()) {
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
            ...(locality.countryCode
              ? { regionCode: locality.countryCode }
              : {}),
          }),
        },
        ResponseSchema,
      );
      const rejected = {
        no_name_match: 0,
        category_conflict: 0,
        country_conflict: 0,
        locality_conflict: 0,
        address_conflict: 0,
        below_threshold: 0,
        ambiguous_score: 0,
      };
      const event: GoogleFilterEvent = {
        event: 'google_places_filter',
        query: queryIndex + 1,
        returned: data.places.length,
        complete: 0,
        nameStrong: 0,
        categoryCompatible: 0,
        localityCompatible: 0,
        addressCompatible: 0,
        accepted: 0,
        result: 'no_match',
        rejected,
      };
      for (const row of data.places) {
        if (!row.displayName || !row.location || !row.formattedAddress)
          continue;
        event.complete++;
        const comparisons = [clue, ...additional]
          .map((evidence) => {
            const evidenceName =
              'canonicalName' in evidence
                ? evidence.canonicalName
                : evidence.name;
            const score = Math.max(
              ...[evidenceName, evidence.nativeName, ...evidence.aliases]
                .filter((n): n is string => !!n)
                .slice(0, 12)
                .map((n) =>
                  locality.aliases.some(
                    (a) => normalizedLocality(n) === normalizedLocality(a),
                  )
                    ? 0
                    : venueNameScore(n, row.displayName!.text),
                ),
            );
            return {
              evidence,
              score,
              support: categorySupport(evidence.category, row.types),
              addressState: addressSignal(
                'addressClue' in evidence ? evidence.addressClue : undefined,
                row,
              ),
            };
          })
          .sort(
            (a, b) =>
              b.score +
              (b.support === 'compatible' ? 0.05 : 0.01) +
              (b.addressState === 'match' ? 0.06 : 0) -
              (a.score +
                (a.support === 'compatible' ? 0.05 : 0.01) +
                (a.addressState === 'match' ? 0.06 : 0)),
          );
        if (!comparisons.some((c) => c.score)) {
          rejected.no_name_match++;
          continue;
        }
        nameMatched = true;
        event.nameStrong++;
        const winning =
          comparisons.find(
            (c) =>
              c.score &&
              c.support !== 'conflict' &&
              c.addressState !== 'conflict',
          ) ?? comparisons.find((c) => c.score && c.support !== 'conflict');
        const nameScore = winning?.score ?? 0,
          support = winning?.support ?? 'conflict';
        const matchingClue = winning?.evidence ?? clue;
        const category = travelType(row.types);
        if (!category || support === 'conflict') {
          rejected.category_conflict++;
          continue;
        }
        categoryMatched = true;
        event.categoryCompatible++;
        const country = row.addressComponents.find((c) =>
          c.types.includes('country'),
        )?.shortText;
        if (locality.countryCode && country !== locality.countryCode) {
          rejected.country_conflict++;
          continue;
        }
        const address = geographicMatch(row, locality);
        if (!address) {
          rejected.locality_conflict++;
          continue;
        }
        geographyMatched = true;
        event.localityCompatible++;
        const addressState = winning!.addressState;
        if (addressState === 'conflict') {
          rejected.address_conflict++;
          continue;
        }
        if (addressState === 'match') event.addressCompatible++;
        const score = Math.min(
          1,
          nameScore +
            0.08 +
            (locality.countryCode ? 0.04 : 0) +
            (support === 'compatible' ? 0.05 : 0.01) +
            (addressState === 'match' ? 0.06 : 0),
        );
        if (score < GOOGLE_MATCH_THRESHOLD) rejected.below_threshold++;
        else event.accepted++;
        const reference = {
          provider: 'google-places',
          externalId: row.id,
          url: `https://www.google.com/maps/search/?api=1&query=Google%20Place&query_place_id=${encodeURIComponent(row.id)}`,
          observedAt: new Date(this.now()).toISOString(),
        };
        const parsed = CandidateSchema.safeParse({
          canonicalName: row.displayName.text,
          ...(matchingClue.nativeName
            ? { nativeName: matchingClue.nativeName.slice(0, 300) }
            : {}),
          aliases: matchingClue.aliases
            .slice(0, 10)
            .map((s) => s.slice(0, 300)),
          category,
          coordinates: { ...row.location, crs: 'WGS84' },
          address: { formatted: row.formattedAddress, ...address },
          references: [...input.data.verification.references, reference],
          confidence: matchingClue.confidence,
          resolution: 'deterministic_poi',
          providerIdentity: { provider: 'google-places', id: row.id },
          ...(row.attributions?.length
            ? { attributions: row.attributions }
            : {}),
        });
        if (!parsed.success)
          throw new GooglePlacesFailure('google_places_response_invalid');
        const previous = candidates.get(row.id);
        if (
          previous &&
          (previous.candidate.coordinates.latitude !== row.location.latitude ||
            previous.candidate.coordinates.longitude !== row.location.longitude)
        )
          throw new GooglePlacesFailure('google_places_response_invalid');
        if (!previous || previous.score < score)
          candidates.set(row.id, { candidate: parsed.data, score });
      }
      if (
        event.localityCompatible > rejected.address_conflict &&
        data.nextPageToken
      )
        truncated = true;
      const ranked = [...candidates.values()].sort((a, b) => b.score - a.score);
      const best = ranked[0],
        runner = ranked[1];
      const confident =
        best &&
        best.score >= GOOGLE_MATCH_THRESHOLD &&
        !truncated &&
        (!runner || best.score - runner.score >= GOOGLE_MATCH_MARGIN);
      event.result = confident
        ? 'resolved'
        : best && best.score >= GOOGLE_MATCH_THRESHOLD
          ? 'ambiguous'
          : 'no_match';
      if (event.result === 'ambiguous') rejected.ambiguous_score = 1;
      try {
        this.diagnostic(event);
      } catch {
        /* best effort */
      }
      if (confident) return { status: 'resolved', candidate: best.candidate };
    }
    if ([...candidates.values()].some((c) => c.score >= GOOGLE_MATCH_THRESHOLD))
      return { status: 'unresolved', reason: 'ambiguous_poi' };
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
