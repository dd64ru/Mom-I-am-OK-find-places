import { googleSearchPlan, type GooglePhase } from './google-search-plan.js';
import { PipelineTelemetry } from './telemetry.js';
import { z } from 'zod';
import { GoogleAuth } from 'google-auth-library';
import { ProviderFailure, type PoiProvider } from '@places/core';
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
import { normalizedLocality, type Locality } from './locality.js';
import {
  venueNameEvidence,
  identityStrength,
  nameTokens,
  categorySupport,
  categoryWeight,
  recognizedCategory,
} from './place-matching.js';
import {
  compareEvidence,
  decideCandidate,
  identityDecision,
  isAccepted,
  type CandidateEvidence,
  type GoogleDecisionEvent,
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
  const namesMatch = (c: GooglePlaceDto['addressComponents'][number]) =>
    [c.longText, c.shortText].some(
      (s) =>
        s &&
        locality?.aliases.some(
          (a) => normalizedLocality(a) === normalizedLocality(s),
        ),
    );
  const cities = row.addressComponents.filter(
    (c) =>
      (c.types.includes('locality') ||
        (locality?.countryCode === 'CN' &&
          c.types.some((t) =>
            [
              'administrative_area_level_1',
              'administrative_area_level_2',
            ].includes(t),
          ) &&
          [c.longText, c.shortText].some((n) => n?.endsWith('市')))) &&
      (c.longText || c.shortText),
  );
  const cityMatch =
    cities.some(namesMatch) ||
    (!cities.length &&
      row.addressComponents
        .filter((c) =>
          c.types.some((t) =>
            [
              'postal_town',
              'administrative_area_level_1',
              'administrative_area_level_2',
            ].includes(t),
          ),
        )
        .some(namesMatch));
  // Canonical locality is stronger than a mailing town/district. Unclear hierarchy is neutral.
  const cityConflict =
    !!locality?.aliases.length && !!cities.length && !cities.some(namesMatch);
  return {
    countryConflict,
    countryMatch,
    cityConflict,
    cityMatch,
    address: {
      ...(cityMatch && locality
        ? { city: locality.name }
        : !locality?.aliases.length && cities[0]?.longText
          ? { city: cities[0].longText }
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
};
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
        | GoogleDecisionEvent,
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
      fieldMask: 'id,displayName,formattedAddress,location,attributions',
    });
    const row = this.parseLog('ok', [loaded.raw], loaded.credential)[0];
    if (!row || row.id !== parsed.data.id)
      throw new GooglePlacesFailure('google_places_response_invalid');
    const display = PlaceDisplaySchema.safeParse({
      canonicalName: row.displayName.text,
      coordinates: { ...row.location, crs: 'WGS84' },
      address: { formatted: row.formattedAddress ?? '' },
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

  firstPass(recognition: Recognition, context: GeographicContext = {}) {
    return this.resolve(
      recognition,
      { status: 'no_evidence', candidates: [], references: [] },
      context,
      'google_first_pass',
    );
  }
  async resolve(
    recognition: Recognition,
    verification: Verification,
    context: GeographicContext = {},
    phase: GooglePhase = 'google_enriched_pass',
  ): Promise<PoiResolution> {
    if (!['google_first_pass', 'google_enriched_pass'].includes(phase))
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
    const {
      clues: boundedClues,
      locality,
      queries,
    } = googleSearchPlan(
      input.data.recognition,
      input.data.verification,
      input.data.context,
    );
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
      });
    } catch {
      /* best effort */
    }
    if (!queries.length)
      return { status: 'unresolved', reason: 'no_place_evidence' };
    const candidates = new Map<
      string,
      { candidate: Candidate; evidence: CandidateEvidence }
    >();
    let categoryMatched = false,
      geographyMatched = false,
      truncated = false;
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
        localityCompatible: 0,
        addressCompatible: 0,
        accepted: 0,
        result: 'no_match',
        rejected,
      };
      const excluded: CandidateEvidence[] = [];
      for (const [rowIndex, row] of rows.entries()) {
        event.complete++;
        const comparisons = boundedClues
          .map((evidence) => {
            const evidenceName =
              'canonicalName' in evidence
                ? evidence.canonicalName
                : evidence.name;
            const name = [
              evidenceName,
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
        const addressState = winning.addressState;
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
          excluded.push(evidence);
          continue;
        }
        if (geography.cityMatch || geography.countryMatch)
          event.localityCompatible++;
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
          address: { formatted: row.formattedAddress ?? '', ...address },
          references: [...input.data.verification.references, reference],
          confidence: matchingClue.confidence,
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
        if (!previous || compareEvidence(evidence, previous.evidence) < 0)
          candidates.set(row.id, { candidate: parsed.data, evidence });
      }
      if (event.accepted > 0 && envelope.nextPageToken) truncated = true;
      const ranked = [...candidates.values()].sort((a, b) =>
        compareEvidence(a.evidence, b.evidence),
      );
      const best = ranked[0],
        runner = ranked[1];
      const topEvidence = best?.evidence ?? excluded.sort(compareEvidence)[0];
      const decision = topEvidence
        ? decideCandidate(topEvidence, runner?.evidence, truncated)
        : 'insufficient_identity';
      event.result = isAccepted(decision)
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
          });
      } catch {
        /* best effort */
      }
      if (best && isAccepted(decision))
        return { status: 'resolved', candidate: best.candidate };
    }
    const plausible = [...candidates.values()].filter(
      (c) => identityStrength(c.evidence.nameEvidence) >= 2,
    );
    if (plausible.some((c) => isAccepted(identityDecision(c.evidence)))) {
      const locations = new Set(
        plausible.map(
          (c) =>
            `${normalizedLocality(c.candidate.address.city ?? '')}:${c.candidate.address.countryCode ?? ''}`,
        ),
      );
      return !locality?.aliases.length &&
        (truncated ||
          locations.size > 1 ||
          [...locations].some((key) => key.startsWith(':')))
        ? { status: 'city_unknown', reason: 'ambiguous_locality' }
        : { status: 'unresolved', reason: 'ambiguous_poi' };
    }
    if (candidates.size)
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
