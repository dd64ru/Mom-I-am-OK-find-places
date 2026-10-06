import { googleSearchPlan, type GooglePhase } from './google-search-plan.js';
import { PipelineTelemetry } from './telemetry.js';
import { z } from 'zod';
import { GoogleAuth } from 'google-auth-library';
import { ProviderFailure, type PoiProvider } from '@places/core';
import {
  CandidateSchema,
  MAX_CANDIDATES,
  MAX_SEARCH_BRANDS,
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
import { normalizedLocality, type Locality } from './locality.js';
import {
  venueNameEvidence,
  providerBaseName,
  identityStrength,
  nameTokens,
  categorySupport,
  categoryWeight,
  recognizedCategory,
} from './place-matching.js';
import {
  compareEvidence,
  candidateConfidence,
  decideCandidate,
  identityDecision,
  isAccepted,
  type CandidateEvidence,
  type GoogleDecisionEvent,
  type GoogleCandidateEvent,
} from './google-candidate-decision.js';
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
  | 'google_places_top_level_invalid'
  | 'google_places_invalid_json'
  | 'google_places_response_too_large'
  | 'google_places_adaptation_failed'
  | 'google_places_transient_failure';
export class GooglePlacesFailure extends ProviderFailure {
  constructor(readonly code: FailureCode) {
    super(code);
    this.name = 'GooglePlacesFailure';
  }
}
import {
  adaptGoogleRow,
  searchEnvelope,
  parseCounts,
  GOOGLE_BODY_LIMIT,
  type GoogleParseEvent,
  type GooglePlaceDto,
} from './google-places-contract.js';
// Equality after script/diacritic/punctuation normalization, never edit-distance/ranking/substring venue matching.
export const normalizedVenueName = (value: string) =>
  value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
function encodeGoogleId(id: string) {
  try {
    return encodeURIComponent(id);
  } catch {
    throw new GooglePlacesFailure('google_places_adaptation_failed');
  }
}
// Exact contiguous tokens; punctuation-separated Han segments may drop the city suffix.
// Never a raw substring (ham cannot match Shanghai; York cannot match Yorkshire).
export function localityInAddress(alias: string, address: string): boolean {
  const wanted = nameTokens(normalizedLocality(alias)).join(' ');
  if (!wanted) return false;
  return address.split(/[,，;；]/u).some((segment) => {
    const tokens = nameTokens(normalizedLocality(segment.trim())).join(' ');
    return ` ${tokens} `.includes(` ${wanted} `);
  });
}
function geographicEvidence(row: GooglePlaceDto, locality?: Locality) {
  const countryCodes = [
    ...new Set(
      row.addressComponents
        .filter((c) => c.types.includes('country'))
        .map((c) => c.shortText)
        .filter((c): c is string => !!c && /^[A-Z]{2}$/.test(c)),
    ),
  ];
  const countryConflict =
    !!locality?.countryCode &&
    countryCodes.some((c) => c !== locality?.countryCode);
  const countryMatch =
    !!locality?.countryCode && countryCodes.includes(locality?.countryCode);
  // Separator/diacritic variants within typed components; no fuzzy city matching.
  const localityKey = (value: string) =>
    normalizedLocality(value)
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .replace(/[^\p{L}\p{N}]/gu, '');
  const namesMatch = (c: GooglePlaceDto['addressComponents'][number]) =>
    [c.longText, c.shortText].some(
      (s) =>
        s && locality?.aliases.some((a) => localityKey(a) === localityKey(s)),
    );
  const relevant = row.addressComponents.filter((c) =>
    c.types.some((t) =>
      [
        'locality',
        'postal_town',
        'administrative_area_level_1',
        'administrative_area_level_2',
      ].includes(t),
    ),
  );
  const direct = relevant.filter((c) => c.types.includes('locality'));
  const postal = relevant.filter((c) => c.types.includes('postal_town'));
  const china = countryCodes.includes('CN');
  // Matching any administrative layer corroborates intent, regardless of response language.
  // Only reliable city-level components contradict it; a different province is neutral.
  const administrativeCities = china
    ? relevant.filter(
        (c) =>
          c.types.includes('administrative_area_level_2') ||
          (c.types.includes('administrative_area_level_1') &&
            [c.longText, c.shortText].some((n) => n?.endsWith('市'))),
      )
    : [];
  const cities = direct.length
    ? direct
    : postal.length
      ? postal
      : administrativeCities;
  const scriptSet = (text: string) =>
    [
      'Latin',
      'Cyrillic',
      'Han',
      'Hangul',
      'Arabic',
      'Greek',
      'Hebrew',
      'Devanagari',
    ].filter((script) => new RegExp(`\\p{Script=${script}}`, 'u').test(text));
  const comparable = (text: string) =>
    locality?.aliases.some((alias) =>
      scriptSet(alias).some((script) => scriptSet(text).includes(script)),
    );
  const cityConflict =
    !!locality?.aliases.length &&
    !!cities.length &&
    !cities.some(namesMatch) &&
    cities.every((c) => comparable(c.longText ?? c.shortText ?? ''));
  const formattedMatch =
    !cities.length &&
    !!locality?.aliases.some((alias) =>
      localityInAddress(alias, row.formattedAddress ?? ''),
    );
  const matchedComponent = relevant.find(namesMatch);
  const cityMatch = !!matchedComponent;
  const displayCity =
    cities[0]?.longText ??
    cities[0]?.shortText ??
    matchedComponent?.longText ??
    matchedComponent?.shortText;
  const administrativeContext = relevant
    .filter((c) =>
      c.types.some((t) => t.startsWith('administrative_area_level_')),
    )
    .map((c) => c.longText ?? c.shortText)
    .filter(Boolean)
    .join(', ');
  return {
    countryConflict,
    countryMatch,
    cityConflict,
    cityMatch,
    localityEvidence:
      cityMatch || cities.length
        ? ('structured' as const)
        : formattedMatch
          ? ('address_context' as const)
          : ('absent' as const),
    address: {
      ...(displayCity ? { city: displayCity } : {}),
      ...(!displayCity && administrativeContext
        ? { providerContext: administrativeContext }
        : {}),
      ...(countryCodes.length === 1 ? { countryCode: countryCodes[0] } : {}),
    },
  };
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
  row: GooglePlaceDto,
): 'match' | 'absent' | 'conflict' {
  if (!clue) return 'absent';
  const wanted = normalizedAddress(clue);
  if (wanted.length < 4) return 'absent';
  const comparable = (s: string) => {
    const plain = s
      .normalize('NFKC')
      .trim()
      .replace(/^(?:no\.?|№)\s*/iu, '');
    if (
      /^[0-9]+(?:\s*[-–—/]\s*[\p{L}\p{N}]|\s+(?:building|bldg|unit|apt|apartment|suite|room|block)\b)/iu.test(
        plain,
      )
    )
      return;
    return normalizedAddress(s).match(/^([0-9]+[a-z]?)(?=\s+[\p{L}]|$)/u)?.[1];
  };
  const number = comparable(clue);
  const explicit = row.addressComponents
    .filter((c) => c.types.includes('street_number'))
    .map((c) => c.longText ?? c.shortText ?? '');
  const sources = [...explicit, row.formattedAddress ?? ''];
  const returnedNumbers = sources
    .map(comparable)
    .filter((n): n is string => !!n);
  if (
    number &&
    returnedNumbers.length &&
    returnedNumbers.some((n) => n !== number)
  )
    return 'conflict';
  const values = [
    row.formattedAddress ?? '',
    ...row.addressComponents.flatMap((c) => [
      c.longText ?? '',
      c.shortText ?? '',
    ]),
  ].map(normalizedAddress);
  return values.some((s) => ` ${s} `.includes(` ${wanted} `))
    ? 'match'
    : 'absent';
}
export type GoogleFilterEvent = {
  event: 'google_places_filter';
  phase: GooglePhase;
  query: number;
  returned: number;
  complete: number;
  nameStrong: number;
  categoryCompatible: number;
  cityCompatible: number;
  countryCompatible: number;
  addressCompatible: number;
  accepted: number;
  result: 'resolved' | 'alternatives' | 'ambiguous' | 'no_match';
  rejected: {
    no_name_match: number;
    category_conflict: number;
    country_conflict: number;
    locality_conflict: number;
    address_conflict: number;
    insufficient_identity: number;
    ambiguous_competition: number;
  };
};
export type GoogleSearchPlanEvent = {
  event: 'place_search_plan';
  phase: GooglePhase;
  visionClues: number;
  confidenceHigh: number;
  confidenceMedium: number;
  confidenceLow: number;
  localityKnown: boolean;
  queriesPlanned: number;
  signagePresent: boolean;
  possibleChainPresent: boolean;
  unscopedQueryPlanned: boolean;
};
export type GoogleRelatedEvent = {
  event: 'google_related_expansion';
  reason:
    | 'no_chain_evidence'
    | 'no_eligible_seed'
    | 'provider_city_unavailable'
    | 'locality_unknown'
    | 'conflicting_locality'
    | 'expanded';
  scope: 'explicit_normalized' | 'explicit_matched' | 'provider' | 'none';
  signagePresent: boolean;
  possibleChainPresent: boolean;
};
function supportedChainName(brand: string, returned: string) {
  if (identityStrength(venueNameEvidence(brand, brand).nameEvidence) < 2)
    return false;
  const wanted = nameTokens(brand),
    actual = nameTokens(returned);
  return (
    identityStrength(venueNameEvidence(brand, returned).nameEvidence) >= 2 ||
    (actual.length >= wanted.length &&
      actual.length - wanted.length <= 3 &&
      wanted.every((word, i) => actual[i] === word))
  );
}
function supportedStructuredChain(clue: Recognition['clues'][number]): boolean {
  return (
    !!clue.possibleChain &&
    normalizedVenueName(clue.possibleChain) !==
      normalizedVenueName(clue.category) &&
    supportedChainName(clue.possibleChain, clue.possibleChain)
  );
}
const relatedCandidate = (candidate: Candidate) =>
  candidate.relationship?.startsWith('related_');
function compareLocations(
  a: { candidate: Candidate; evidence: CandidateEvidence },
  b: { candidate: Candidate; evidence: CandidateEvidence },
) {
  return (
    Number(!!relatedCandidate(a.candidate)) -
      Number(!!relatedCandidate(b.candidate)) ||
    compareEvidence(a.evidence, b.evidence)
  );
}
export type GoogleBrandEvent = {
  event: 'recommendation_brand_search';
  brandSlot: number;
  queriesAllocated: 1;
  eligible: number;
  displayed: number;
  outcome:
    | 'results'
    | 'no_match'
    | 'insufficient_evidence'
    | 'locality_mismatch'
    | 'transient_failure'
    | 'empty_response'
    | 'geographic_conflict';
};
// Only a full exact short identity (optionally explicit branch metadata) may bypass
// the single-photo short-name ambiguity rule. Partial/weak short tokens never do.
function recommendationNameEvidence(name: string, returned: string) {
  const normal = venueNameEvidence(name, returned);
  if (
    identityStrength(normal.nameEvidence) < 2 &&
    nameTokens(name).join('').length >= 2 &&
    normalizedVenueName(name) ===
      normalizedVenueName(providerBaseName(returned))
  )
    return { nameEvidence: 'exact' as const, nameRank: 0.96 };
  return normal;
}
type GoogleAttempt = {
  recommendationIndex?: number;
  recommendationResolution?: PoiResolution;
  potentialRelatedIds: Set<string>;
  hardRejectedIds: Set<string>;

  truncated: boolean;
  relatedExpanded: boolean;
  relatedQuery?: string;
  hardGeographyConflict?: boolean;
  candidates: Map<
    string,
    { candidate: Candidate; evidence: CandidateEvidence }
  >;
  slots: Map<string, { slot: number; queries: Set<string> }>;
};
const newAttempt = (): GoogleAttempt => ({
  candidates: new Map(),
  potentialRelatedIds: new Set(),
  hardRejectedIds: new Set(),
  slots: new Map(),
  truncated: false,
  relatedExpanded: false,
});
export class GooglePlacesPoi implements PoiProvider {
  constructor(
    private readonly accessToken: () => Promise<string>,
    private readonly quotaProject: string,
    private readonly request: typeof fetch = fetch,
    private readonly now = Date.now,
    private readonly diagnostic: (
      event:
        | GoogleFilterEvent
        | GoogleParseEvent
        | GoogleSearchPlanEvent
        | GoogleRelatedEvent
        | GoogleDecisionEvent
        | GoogleCandidateEvent
        | GoogleBrandEvent,
    ) => void = () => {},
    private readonly telemetry = new PipelineTelemetry(),
  ) {
    if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(quotaProject))
      throw new GooglePlacesFailure('google_places_configuration_invalid');
  }
  private parseLog(
    topLevel: GoogleParseEvent['topLevel'],
    rows: unknown[] = [],
    credential?: string,
  ) {
    const skipped = parseCounts();
    const usable: GooglePlaceDto[] = [];
    for (const raw of rows) {
      const parsed = adaptGoogleRow(raw, credential);
      if (parsed.code === 'usable') usable.push(parsed.row);
      else skipped[parsed.code]++;
    }
    try {
      this.diagnostic({
        event: 'google_places_parse',
        topLevel,
        rowsReturned: rows.length,
        rowsUsable: usable.length,
        rowsSkipped: rows.length - usable.length,
        skipped,
      });
    } catch {
      /* best effort */
    }
    return usable;
  }
  private async load(
    endpoint: string,
    init: {
      method: 'POST' | 'GET';
      fieldMask: string;
      body?: string;
      phase?: GooglePhase;
    },
  ): Promise<{ raw: unknown; credential: string }> {
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
      response = await this.telemetry.measure(
        'google_places',
        () =>
          this.request(endpoint, {
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
          }),
        (response) => (response.ok ? 'ok' : 'error'),
        init.phase,
      );
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
    let data: unknown;
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
          if (size > GOOGLE_BODY_LIMIT) {
            this.parseLog('response_too_large');
            throw new GooglePlacesFailure('google_places_response_too_large');
          }
          chunks.push(chunk.value);
        }
      } finally {
        try {
          await reader.cancel();
        } catch {
          /* cleanup must not mask the classified failure */
        }
        reader.releaseLock();
      }
      try {
        data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        this.parseLog('invalid_json');
        throw new GooglePlacesFailure('google_places_invalid_json');
      }
    } catch (error) {
      if (error instanceof GooglePlacesFailure) throw error;
      throw new GooglePlacesFailure(
        signal.aborted
          ? 'google_places_transient_failure'
          : 'google_places_response_invalid',
      );
    }
    return { raw: data, credential: token };
  }
  // Refresh is a read-only, transient provider view. Callers must not save it as a Place.
  async refresh(identity: {
    provider: string;
    id: string;
  }): Promise<PlaceDisplay> {
    const parsed = GoogleIdentitySchema.safeParse(identity);
    if (!parsed.success)
      throw new GooglePlacesFailure('google_places_request_failed');
    const endpoint =
      'https://places.googleapis.com/v1/places/' +
      encodeGoogleId(parsed.data.id);
    // Dot-only opaque IDs cannot be represented as one HTTP path segment; never request a normalized parent URL.
    if (
      new URL(endpoint).pathname !==
      '/v1/places/' + encodeGoogleId(parsed.data.id)
    )
      throw new GooglePlacesFailure('google_places_adaptation_failed');
    const loaded = await this.load(endpoint, {
      method: 'GET',
      fieldMask:
        'id,displayName,formattedAddress,location,addressComponents,attributions',
    });
    const row = this.parseLog('ok', [loaded.raw], loaded.credential)[0];
    if (!row || row.id !== parsed.data.id)
      throw new GooglePlacesFailure('google_places_response_invalid');
    const display = PlaceDisplaySchema.safeParse({
      canonicalName: row.displayName.text,
      coordinates: { ...row.location, crs: 'WGS84' },
      address: {
        formatted: row.formattedAddress ?? '',
        ...geographicEvidence(row).address,
      },
      providerIdentity: parsed.data,
      references: [
        {
          provider: 'google-places',
          externalId: row.id,
          url: `https://www.google.com/maps/search/?api=1&query=Google%20Place&query_place_id=${encodeGoogleId(row.id)}`,
          observedAt: new Date(this.now()).toISOString(),
        },
      ],
      ...(row.attributions?.length ? { attributions: row.attributions } : {}),
    });
    if (!display.success)
      throw new GooglePlacesFailure('google_places_adaptation_failed');
    return display.data;
  }

  beginAttempt(): PoiProvider {
    const attempt = newAttempt();
    return {
      firstPass: (r, c, normalization) =>
        this.resolve(
          r,
          normalization ?? {
            status: 'no_evidence',
            candidates: [],
            references: [],
          },
          c,
          'google_first_pass',
          attempt,
        ),
      resolve: (r, v, c) =>
        this.resolve(r, v, c, 'google_enriched_pass', attempt),
      refresh: (identity) => this.refresh(identity),
    };
  }
  firstPass(
    recognition: Recognition,
    context: GeographicContext = {},
    normalization?: Verification,
  ) {
    return this.resolve(
      recognition,
      normalization ?? {
        status: 'no_evidence',
        candidates: [],
        references: [],
      },
      context,
      'google_first_pass',
    );
  }
  async resolve(
    recognition: Recognition,
    verification: Verification,
    context: GeographicContext = {},
    phase: GooglePhase = 'google_enriched_pass',
    attempt = newAttempt(),
  ): Promise<PoiResolution> {
    if (
      ![
        'google_first_pass',
        'google_enriched_pass',
        'google_related_pass',
      ].includes(phase)
    )
      throw new GooglePlacesFailure('google_places_request_failed');
    const input = z
      .object({
        recognition: RecognitionSchema,
        verification: VerificationSchema,
        context: GeographicContextSchema,
      })
      .safeParse({ recognition, verification, context });
    if (!input.success)
      throw new GooglePlacesFailure('google_places_request_failed');
    if (input.data.recognition.mode === 'recommendation_list') {
      return (
        attempt.recommendationResolution ??
        (attempt.recommendationResolution = await this.resolveRecommendations(
          input.data.recognition,
          input.data.verification,
          input.data.context,
          phase,
        ))
      );
    }
    const {
      clues: boundedClues,
      locality,
      queries: plannedQueries,
      unscopedQueryPlanned,
    } = googleSearchPlan(
      input.data.recognition,
      input.data.verification,
      input.data.context,
    );
    const queries =
      phase === 'google_related_pass'
        ? [attempt.relatedQuery!]
        : attempt.recommendationIndex !== undefined
          ? [
              [
                recognition.clues[0]!.nativeName || recognition.clues[0]!.name,
                locality?.name,
                locality?.countryCode,
              ]
                .filter(Boolean)
                .join(', ')
                .slice(0, 800),
            ]
          : plannedQueries;
    try {
      this.diagnostic({
        event: 'place_search_plan',
        phase,
        visionClues: Math.min(3, recognition.clues.length),
        confidenceHigh: recognition.clues
          .slice(0, 3)
          .filter((c) => c.confidence >= 0.85).length,
        confidenceMedium: recognition.clues
          .slice(0, 3)
          .filter((c) => c.confidence >= 0.5 && c.confidence < 0.85).length,
        confidenceLow: recognition.clues
          .slice(0, 3)
          .filter((c) => c.confidence < 0.5).length,
        localityKnown: !!locality?.aliases.length,
        queriesPlanned: queries.length,
        signagePresent: recognition.clues.some((c) => !!c.signage),
        possibleChainPresent: recognition.clues.some((c) => !!c.possibleChain),
        unscopedQueryPlanned:
          phase !== 'google_related_pass' && unscopedQueryPlanned,
      });
    } catch {
      /* best effort */
    }
    if (!queries.length)
      return { status: 'unresolved', reason: 'no_place_evidence' };
    const candidates = attempt.candidates;
    let categoryMatched = false,
      geographyMatched = false,
      truncated = false,
      ineligibleIdentity = false;
    for (const [queryIndex, query] of queries.entries()) {
      const loaded = await this.load(GOOGLE_PLACES_ENDPOINT, {
        method: 'POST',
        phase,
        fieldMask: GOOGLE_PLACES_FIELD_MASK,
        body: JSON.stringify({
          textQuery: query,
          languageCode: 'en',
          pageSize: 10,
          includePureServiceAreaBusinesses: false,
          ...(locality?.countryCode
            ? { regionCode: locality.countryCode }
            : {}),
        }),
      });
      const envelope = searchEnvelope(loaded.raw);
      if (!envelope) {
        this.parseLog('top_level_invalid');
        throw new GooglePlacesFailure('google_places_top_level_invalid');
      }
      const rows = this.parseLog('ok', envelope.places, loaded.credential);
      // Processing budget is separate from external response validity.
      if (rows.length > 10) {
        truncated = true;
        attempt.truncated = true;
      }
      const rejected = {
        no_name_match: 0,
        category_conflict: 0,
        country_conflict: 0,
        locality_conflict: 0,
        address_conflict: 0,
        insufficient_identity: 0,
        ambiguous_competition: 0,
      };
      const event: GoogleFilterEvent = {
        event: 'google_places_filter',
        phase,
        query: queryIndex + 1,
        returned: envelope.places.length,
        complete: 0,
        nameStrong: 0,
        categoryCompatible: 0,
        cityCompatible: 0,
        countryCompatible: 0,
        addressCompatible: 0,
        accepted: 0,
        result: 'no_match',
        rejected,
      };
      const excluded: CandidateEvidence[] = [];
      for (const [rowIndex, row] of rows.slice(0, 10).entries()) {
        event.complete++;
        const comparisons = boundedClues
          .map((evidence) => {
            const evidenceName =
              'canonicalName' in evidence
                ? evidence.canonicalName
                : evidence.name;
            const name = [
              evidenceName,
              ...('signage' in evidence && evidence.signage
                ? [evidence.signage]
                : []),
              evidence.nativeName,
              ...evidence.aliases,
            ]
              .filter((n): n is string => !!n)
              .slice(0, 12)
              .map((n) =>
                locality?.aliases.some(
                  (a) => normalizedLocality(n) === normalizedLocality(a),
                )
                  ? { nameEvidence: 'none' as const, nameRank: 0 }
                  : attempt.recommendationIndex !== undefined
                    ? recommendationNameEvidence(n, row.displayName.text)
                    : venueNameEvidence(n, row.displayName.text),
              )
              .sort(
                (a, b) =>
                  identityStrength(b.nameEvidence) -
                    identityStrength(a.nameEvidence) || b.nameRank - a.nameRank,
              )[0]!;
            return {
              evidence,
              ...name,
              support: categorySupport(evidence.category, row.types),
              addressState: addressSignal(
                'addressClue' in evidence ? evidence.addressClue : undefined,
                row,
              ),
            };
          })
          .sort(
            (a, b) =>
              identityStrength(b.nameEvidence) -
                identityStrength(a.nameEvidence) ||
              b.nameRank +
                categoryWeight(b.support) +
                (b.addressState === 'match' ? 0.06 : 0) -
                (a.nameRank +
                  categoryWeight(a.support) +
                  (a.addressState === 'match' ? 0.06 : 0)),
          );
        const winning =
          comparisons.find(
            (c) =>
              identityStrength(c.nameEvidence) >= 2 &&
              c.addressState !== 'conflict',
          ) ?? comparisons[0]!;
        const matchingClue = winning.evidence;
        const support = winning.support;
        const category =
          recognizedCategory(row.types) ?? matchingClue.category ?? 'place';
        const geography = geographicEvidence(row, locality);
        const exactChainAddressConflict =
          phase !== 'google_related_pass' &&
          (attempt.recommendationIndex !== undefined ||
            input.data.recognition.clues.some(supportedStructuredChain)) &&
          input.data.verification.status === 'verified' &&
          input.data.verification.references.length > 0 &&
          comparisons.some(
            (c) =>
              'canonicalName' in c.evidence &&
              identityStrength(c.nameEvidence) === 3 &&
              c.addressState === 'conflict',
          );
        const addressState = exactChainAddressConflict
          ? 'conflict'
          : winning.addressState;
        const evidence: CandidateEvidence = {
          nameEvidence: winning.nameEvidence,
          nameRank: winning.nameRank,
          localityState: geography.cityConflict
            ? 'conflict'
            : geography.cityMatch
              ? 'match'
              : 'unknown',
          countryState: geography.countryConflict
            ? 'conflict'
            : geography.countryMatch
              ? 'match'
              : 'unknown',
          addressState,
          categoryState: support,
          verifiedWeb:
            input.data.verification.status === 'verified' &&
            input.data.verification.references.length > 0,
          providerRank: rowIndex + 1,
          finalRank: Math.max(
            0,
            Math.min(
              1,
              winning.nameRank +
                (geography.cityMatch ? 0.08 : 0) +
                (geography.countryMatch ? 0.04 : 0) +
                categoryWeight(support) +
                (addressState === 'match' ? 0.06 : 0),
            ),
          ),
        };
        const chain = input.data.recognition.clues.find(
          (c) =>
            supportedStructuredChain(c) &&
            supportedChainName(c.possibleChain!, row.displayName.text) &&
            ['compatible', 'related'].includes(
              categorySupport(c.category, row.types),
            ),
        );
        const signage = input.data.recognition.clues
          .filter((c) => c.signage)
          .sort((a, b) => b.confidence - a.confidence)[0]?.signage;
        const signageMatch = signage
          ? venueNameEvidence(signage, row.displayName.text).nameEvidence
          : undefined;
        const signExact =
          signageMatch === 'exact' ||
          signageMatch === 'reordered' ||
          signageMatch === 'distinctive_equivalent';
        const signPartial =
          signageMatch === 'strong_partial' || signageMatch === 'bounded_typo';
        const userRelated =
          context.relatedRequested &&
          ((phase === 'google_related_pass' && !candidates.has(row.id)) ||
            attempt.potentialRelatedIds.has(row.id)) &&
          input.data.recognition.clues.some(
            (c) =>
              supportedChainName(
                c.signage ?? c.nativeName ?? c.name,
                row.displayName.text,
              ) &&
              ['compatible', 'related'].includes(
                categorySupport(c.category, row.types),
              ),
          );
        const related =
          !!userRelated ||
          (!!chain &&
            (signage
              ? !signExact && !signPartial
              : identityStrength(evidence.nameEvidence) < 2));
        const relationship = related
          ? ('related_chain_location' as const)
          : (
                signage
                  ? signExact
                  : identityStrength(evidence.nameEvidence) === 3
              )
            ? ('likely_exact' as const)
            : ('plausible_exact' as const);
        const slot = attempt.slots.get(row.id) ?? {
          slot: attempt.slots.size + 1,
          queries: new Set<string>(),
        };
        slot.queries.add(`${phase}:${queryIndex + 1}`);
        attempt.slots.set(row.id, slot);
        const weakEligible =
          attempt.recommendationIndex === undefined &&
          !(context.relatedRequested && phase === 'google_related_pass') &&
          evidence.nameEvidence === 'weak' &&
          identityStrength(
            venueNameEvidence(
              'canonicalName' in matchingClue
                ? matchingClue.canonicalName
                : (matchingClue.signage ?? matchingClue.name),
              'canonicalName' in matchingClue
                ? matchingClue.canonicalName
                : (matchingClue.signage ?? matchingClue.name),
            ).nameEvidence,
          ) >= 2 &&
          evidence.categoryState !== 'conflict' &&
          (evidence.localityState === 'match' ||
            evidence.addressState === 'match' ||
            evidence.verifiedWeb ||
            ['compatible', 'related'].includes(evidence.categoryState));
        try {
          this.diagnostic({
            event: 'google_places_candidate',
            phase,
            query: queryIndex + 1,
            candidateSlot: slot.slot,
            relationship,
            providerRank: evidence.providerRank,
            nameEvidence: evidence.nameEvidence,
            nameRankPermille: Math.round(evidence.nameRank * 1000),
            localityState: evidence.localityState,
            localityEvidence: geography.localityEvidence,
            countryState: evidence.countryState,
            addressState: evidence.addressState,
            categoryState: evidence.categoryState,
            finalRankPermille: Math.round(evidence.finalRank * 1000),
            candidateConfidence:
              identityDecision(evidence) === 'rejected_hard_conflict'
                ? undefined
                : weakEligible || related
                  ? 'low'
                  : isAccepted(identityDecision(evidence))
                    ? candidateConfidence(evidence)
                    : undefined,
            decision:
              identityDecision(evidence) === 'rejected_hard_conflict'
                ? 'rejected_hard_conflict'
                : related
                  ? 'eligible_related_location'
                  : weakEligible
                    ? 'eligible_weak_alternative'
                    : identityDecision(evidence),
            seenInMultipleQueries: slot.queries.size > 1,
          });
        } catch {
          /* best effort */
        }
        const rowDecision = identityDecision(evidence);
        if (identityStrength(evidence.nameEvidence) >= 2) {
          event.nameStrong++;
          categoryMatched = true;
        } else rejected.no_name_match++;
        // This count is a soft category disagreement, never a rejection by itself.
        if (support === 'conflict') rejected.category_conflict++;
        else if (support !== 'unknown') event.categoryCompatible++;
        if (geography.countryConflict) rejected.country_conflict++;
        if (geography.cityConflict) rejected.locality_conflict++;
        if (addressState === 'conflict') rejected.address_conflict++;
        if (!geography.countryConflict && !geography.cityConflict)
          geographyMatched = true;
        if (rowDecision === 'rejected_hard_conflict') {
          attempt.hardGeographyConflict = true;
          attempt.hardRejectedIds.add(row.id);
          candidates.delete(row.id);
          excluded.push(evidence);
          continue;
        }
        if (!isAccepted(rowDecision) && !weakEligible && !related) {
          ineligibleIdentity = true;
          continue;
        }
        if (userRelated) attempt.potentialRelatedIds.add(row.id);
        if (geography.cityMatch) event.cityCompatible++;
        if (geography.countryMatch) event.countryCompatible++;
        if (addressState === 'match') event.addressCompatible++;
        if (isAccepted(rowDecision)) event.accepted++;
        else rejected.insufficient_identity++;
        const address = geography.address;
        const reference = {
          provider: 'google-places',
          externalId: row.id,
          url: `https://www.google.com/maps/search/?api=1&query=Google%20Place&query_place_id=${encodeGoogleId(row.id)}`,
          observedAt: new Date(this.now()).toISOString(),
        };
        const independent = input.data.recognition.clues
          .map((clue, index) => {
            const match = [clue.name, clue.nativeName, ...clue.aliases]
              .filter((n): n is string => !!n)
              .slice(0, 12)
              .map((n) =>
                attempt.recommendationIndex !== undefined
                  ? recommendationNameEvidence(n, row.displayName.text)
                  : venueNameEvidence(n, row.displayName.text),
              )
              .sort(
                (a, b) =>
                  identityStrength(b.nameEvidence) -
                    identityStrength(a.nameEvidence) || b.nameRank - a.nameRank,
              )[0]!;
            return { index, match };
          })
          .filter((c) => identityStrength(c.match.nameEvidence) >= 2)
          .sort(
            (a, b) =>
              identityStrength(b.match.nameEvidence) -
                identityStrength(a.match.nameEvidence) ||
              b.match.nameRank - a.match.nameRank,
          );
        const recognitionClueIndex =
          attempt.recommendationIndex ??
          independent[0]?.index ??
          (input.data.recognition.clues.length === 1 ? 0 : undefined);
        const parsed = CandidateSchema.safeParse({
          ...(recognitionClueIndex !== undefined
            ? { recognitionClueIndex }
            : {}),
          canonicalName: row.displayName.text,
          ...(matchingClue.nativeName
            ? { nativeName: matchingClue.nativeName.slice(0, 300) }
            : {}),
          aliases: matchingClue.aliases
            .slice(0, 10)
            .map((s) => s.slice(0, 300)),
          category,
          coordinates: { ...row.location, crs: 'WGS84' },
          address: { formatted: row.formattedAddress ?? '', ...address },
          references: [...input.data.verification.references, reference],
          confidence: matchingClue.confidence,
          relationship,
          candidateConfidence:
            weakEligible || related ? 'low' : candidateConfidence(evidence),
          resolution: 'deterministic_poi',
          providerIdentity: { provider: 'google-places', id: row.id },
          ...(row.attributions?.length
            ? { attributions: row.attributions }
            : {}),
        });
        if (!parsed.success)
          throw new GooglePlacesFailure('google_places_adaptation_failed');
        const previous = candidates.get(row.id);
        if (
          previous &&
          (previous.candidate.coordinates.latitude !== row.location.latitude ||
            previous.candidate.coordinates.longitude !== row.location.longitude)
        )
          throw new GooglePlacesFailure('google_places_response_invalid');
        if (
          !previous ||
          compareLocations({ candidate: parsed.data, evidence }, previous) < 0
        )
          candidates.set(row.id, { candidate: parsed.data, evidence });
      }
      if (candidates.size > 0 && envelope.nextPageToken) {
        truncated = true;
        attempt.truncated = true;
      }
      const ranked = [...candidates.values()].sort((a, b) =>
        compareLocations(a, b),
      );
      const best = ranked[0],
        runner = ranked[1];
      const topEvidence = best?.evidence ?? excluded.sort(compareEvidence)[0];
      const decision =
        best &&
        (ranked.length > 1 ||
          truncated ||
          attempt.truncated ||
          !isAccepted(identityDecision(best.evidence)))
          ? ('shortlist_required' as const)
          : topEvidence
            ? decideCandidate(
                topEvidence,
                runner?.evidence,
                truncated || attempt.truncated,
              )
            : 'insufficient_identity';
      event.result =
        decision === 'shortlist_required'
          ? 'alternatives'
          : isAccepted(decision)
            ? 'resolved'
            : decision === 'ambiguous_competition'
              ? 'ambiguous'
              : 'no_match';
      if (event.result === 'ambiguous') rejected.ambiguous_competition = 1;
      try {
        this.diagnostic(event);
        if (topEvidence)
          this.diagnostic({
            event: 'google_places_decision',
            phase,
            query: queryIndex + 1,
            nameEvidence: topEvidence.nameEvidence,
            nameRankPermille: Math.round(topEvidence.nameRank * 1000),
            localityState: topEvidence.localityState,
            countryState: topEvidence.countryState,
            addressState: topEvidence.addressState,
            categoryState: topEvidence.categoryState,
            finalRankPermille: Math.round(topEvidence.finalRank * 1000),
            runnerUpRankPermille: Math.round(
              (runner?.evidence.finalRank ?? 0) * 1000,
            ),
            decision,
            candidateConfidence:
              decision === 'shortlist_required'
                ? 'low'
                : isAccepted(decision)
                  ? candidateConfidence(topEvidence)
                  : undefined,
          });
      } catch {
        /* best effort */
      }
      if (
        best &&
        ranked.length === 1 &&
        isAccepted(decision) &&
        !relatedCandidate(best.candidate)
      ) {
        const expanded = await this.expandRelated(
          input.data.recognition,
          input.data.verification,
          input.data.context,
          attempt,
        );
        if (expanded) return expanded;
        return { status: 'resolved', candidate: best.candidate };
      }
    }
    const expanded = await this.expandRelated(
      input.data.recognition,
      input.data.verification,
      input.data.context,
      attempt,
    );
    if (expanded) return expanded;
    const alternatives = [...candidates.values()]
      .sort((a, b) => compareLocations(a, b))
      .slice(0, MAX_CANDIDATES)
      .map(({ candidate }) => ({
        ...candidate,
        candidateConfidence: 'low' as const,
      }));
    if (alternatives.length === 1)
      return { status: 'resolved', candidate: alternatives[0]! };
    if (alternatives.length)
      return { status: 'alternatives', candidates: alternatives };

    if (ineligibleIdentity)
      return { status: 'unresolved', reason: 'insufficient_evidence' };
    if (geographyMatched) return { status: 'unresolved', reason: 'no_match' };
    if (categoryMatched)
      return locality?.source === 'vision'
        ? { status: 'city_unknown', reason: 'ambiguous_locality' }
        : { status: 'unresolved', reason: 'locality_mismatch' };
    return {
      status: 'unresolved',
      reason: 'no_match',
    };
  }
  private async resolveRecommendations(
    r: Recognition,
    v: Verification,
    context: GeographicContext,
    phase: GooglePhase,
  ): Promise<PoiResolution> {
    const indices = context.selectedBrandIndices;
    if (
      !indices?.length ||
      indices.length > MAX_SEARCH_BRANDS ||
      new Set(indices).size !== indices.length ||
      indices.some((i) => !r.clues[i])
    )
      throw new GooglePlacesFailure('google_places_request_failed');
    if (!context.cityOverride)
      return { status: 'city_unknown', reason: 'missing_locality' };
    const groups: {
      index: number;
      rows: Candidate[];
      eligible: number;
      outcome: GoogleBrandEvent['outcome'];
    }[] = [];
    let transient: GooglePlacesFailure | undefined;
    const hardRejectedIds = new Set<string>();
    for (const index of indices) {
      const clue = r.clues[index]!;
      const scope = newAttempt();
      scope.recommendationIndex = index;
      // Each brand gets precisely one query of its full identity. Independent
      // request/ranking state prevents sibling names or chain claims leaking in.
      const candidates = v.candidates.filter(
        (c) =>
          identityStrength(
            recommendationNameEvidence(clue.name, c.canonicalName).nameEvidence,
          ) >= 2,
      );
      let result: PoiResolution;
      try {
        result = await this.resolve(
          {
            visibleText: [],
            clues: [{ ...clue, possibleChain: undefined, signage: undefined }],
          },
          { ...v, candidates },
          { ...context, relatedRequested: false },
          phase,
          scope,
        );
      } catch (error) {
        if (
          !(error instanceof GooglePlacesFailure) ||
          error.code !== 'google_places_transient_failure'
        )
          throw error;
        transient = error;
        groups.push({
          index,
          rows: [],
          eligible: 0,
          outcome: 'transient_failure',
        });
        continue;
      }
      for (const id of scope.hardRejectedIds) hardRejectedIds.add(id);
      const rows =
        result.status === 'resolved'
          ? [result.candidate]
          : result.status === 'alternatives'
            ? result.candidates
            : [];
      const outcome = rows.length
        ? 'results'
        : scope.hardGeographyConflict
          ? 'geographic_conflict'
          : !scope.slots.size
            ? 'empty_response'
            : result.status === 'unresolved' &&
                ['insufficient_evidence', 'locality_mismatch'].includes(
                  result.reason,
                )
              ? (result.reason as 'insufficient_evidence' | 'locality_mismatch')
              : 'no_match';
      groups.push({ index, rows, eligible: scope.candidates.size, outcome });
    }
    // Fair round-robin: every successful selected brand gets a first slot before
    // extra branches. Identity is the Place ID, never a similar display name.
    for (const group of groups)
      group.rows = group.rows.filter(
        (c) => !hardRejectedIds.has(c.providerIdentity!.id),
      );
    const unique = new Map<string, Candidate>();
    for (
      let position = 0;
      position < MAX_CANDIDATES && unique.size < MAX_CANDIDATES;
      position++
    ) {
      for (const group of groups) {
        const row = group.rows[position];
        const previous = row && unique.get(row.providerIdentity!.id);
        if (
          previous &&
          (previous.coordinates.latitude !== row!.coordinates.latitude ||
            previous.coordinates.longitude !== row!.coordinates.longitude)
        )
          throw new GooglePlacesFailure('google_places_response_invalid');
        if (row && !previous && unique.size < MAX_CANDIDATES)
          unique.set(row.providerIdentity!.id, {
            ...row,
            candidateConfidence: 'low',
          });
      }
    }
    const selected = [...unique.values()].sort(
      (a, b) => a.recognitionClueIndex! - b.recognitionClueIndex!,
    );
    for (const [slot, group] of groups.entries()) {
      try {
        this.diagnostic({
          event: 'recommendation_brand_search',
          brandSlot: slot + 1,
          queriesAllocated: 1,
          eligible: group.eligible,
          displayed: selected.filter(
            (c) => c.recognitionClueIndex === group.index,
          ).length,
          outcome: group.outcome,
        });
      } catch {
        /* best effort */
      }
    }
    if (!selected.length && transient) throw transient;
    if (!selected.length) return { status: 'unresolved', reason: 'no_match' };
    return { status: 'alternatives', candidates: selected };
  }
  private async expandRelated(
    r: Recognition,
    v: Verification,
    context: GeographicContext,
    attempt: GoogleAttempt,
  ): Promise<PoiResolution | undefined> {
    if (attempt.relatedExpanded || attempt.recommendationIndex !== undefined)
      return;
    const report = (
      reason: GoogleRelatedEvent['reason'],
      scope: GoogleRelatedEvent['scope'] = 'none',
    ) => {
      try {
        this.diagnostic({
          event: 'google_related_expansion',
          reason,
          scope,
          signagePresent: r.clues.some((c) => !!c.signage),
          possibleChainPresent: r.clues.some((c) => !!c.possibleChain),
        });
      } catch {
        /* best effort */
      }
    };
    const chains = r.clues.filter(supportedStructuredChain);
    if (context.relatedRequested) {
      for (const clue of r.clues) {
        const identity = clue.signage ?? clue.nativeName ?? clue.name;
        if (
          !supportedStructuredChain(clue) &&
          normalizedVenueName(identity) !==
            normalizedVenueName(clue.category) &&
          supportedChainName(identity, identity)
        )
          chains.push({ ...clue, possibleChain: identity });
      }
    }
    if (!chains.length) {
      report('no_chain_evidence');
      return;
    }
    const entries = [...attempt.candidates.values()];
    const pairs = chains.flatMap((clue) =>
      entries
        .filter(
          (p) =>
            supportedChainName(
              clue.possibleChain!,
              p.candidate.canonicalName,
            ) &&
            ['compatible', 'related'].includes(
              categorySupport(clue.category, [p.candidate.category]),
            ),
        )
        .map((seed) => ({ clue, seed })),
    );
    const intent =
      context.cityOverride &&
      v.localityIntent?.input === context.cityOverride &&
      v.localityIntent.confidence >= 0.9
        ? v.localityIntent
        : undefined;
    const pair = context.cityOverride
      ? ((!intent
          ? pairs.find((p) => p.seed.evidence.localityState === 'match')
          : undefined) ?? pairs[0])
      : (pairs.find((p) => !!p.seed.candidate.address.city) ?? pairs[0]);
    if (!pair) {
      report(
        attempt.hardGeographyConflict
          ? 'conflicting_locality'
          : 'no_eligible_seed',
      );
      return;
    }
    const { clue, seed } = pair;
    let city: string;
    let normalized = v;
    let relatedContext = context;
    let scope: GoogleRelatedEvent['scope'];
    if (context.cityOverride) {
      if (intent) {
        // This is a search scope, not verified provider geography. Never replace
        // the explicit user locality with an uncorroborated provider city.
        city = intent.canonicalName;
        scope = 'explicit_normalized';
      } else if (seed.evidence.localityState === 'match') {
        city = context.cityOverride;
        scope = 'explicit_matched';
      } else {
        report('locality_unknown');
        return;
      }
    } else {
      const cities = [
        ...new Set(
          entries.map((p) => p.candidate.address.city).filter(Boolean),
        ),
      ];
      if (!seed.candidate.address.city || cities.length !== 1) {
        report('provider_city_unavailable');
        return;
      }
      city = cities[0]!;
      scope = 'provider';
      relatedContext = { ...context, cityOverride: city };
      normalized = {
        ...v,
        localityIntent: {
          input: city,
          canonicalName: city,
          aliases: [],
          confidence: 1,
          ...(seed.candidate.address.countryCode
            ? { countryCode: seed.candidate.address.countryCode }
            : {}),
        },
      };
    }
    attempt.relatedExpanded = true;
    attempt.relatedQuery = `${clue.possibleChain} locations, ${city}`;
    report('expanded', scope);
    return this.resolve(
      r,
      normalized,
      relatedContext,
      'google_related_pass',
      attempt,
    );
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
