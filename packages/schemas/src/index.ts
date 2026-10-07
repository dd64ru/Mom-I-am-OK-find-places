import { z } from 'zod';
export const IdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const Timestamp = z.string().datetime();
export const MAX_CANDIDATES = 8;
export const MAX_RECOMMENDATIONS = 8;
export const MAX_SEARCH_BRANDS = 5;
const RelationshipSchema = z.enum([
  'likely_exact',
  'plausible_exact',
  'related_branch',
  'related_chain_location',
  'viewpoint_hypothesis',
]);
const Confidence = z.number().min(0).max(1);
const AttributionsSchema = z.array(
  z
    .object({ provider: z.string().min(1), providerUri: z.string().optional() })
    .strict(),
);
// Opaque external identity; transport/storage safety is separate from provider-ID validity.
export const GooglePlaceIdSchema = z.string().min(1);
export type GooglePlaceId = z.infer<typeof GooglePlaceIdSchema>;
export const CoordinatesSchema = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    crs: z.literal('WGS84'),
  })
  .strict();
export const ReferenceSchema = z
  .object({
    provider: z.string().min(1),
    externalId: z.string().optional(),
    url: z.string().url().optional(),
    observedAt: Timestamp,
  })
  .strict();
export const AddressSchema = z
  .object({
    formatted: z.string(),
    countryCode: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
    city: z.string().optional(),
    providerContext: z.string().optional(),
    district: z.string().optional(),
  })
  .strict();
export const ApplicationLabelSchema = z
  .object({
    label: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .refine((s) => !/[\u0000-\u001f\u007f]/u.test(s)),
    labelSource: z.enum(['recognition', 'user', 'application']),
  })
  .strict();
// Used for new confirmations only; historical labels remain readable.
export const NewSavedLabelSchema = z
  .string()
  .max(300)
  .refine((s) => !/\p{Cc}/u.test(s))
  .transform((s) => s.trim())
  .pipe(ApplicationLabelSchema.shape.label)
  .refine(
    (s) => !/^(?:saved place(?: \d+)?|viewpoint hypothesis|place)$/iu.test(s),
    'meaningful_label_required',
  );
export const SelectedLabelSchema = z
  .object({
    index: z
      .number()
      .int()
      .min(0)
      .max(MAX_CANDIDATES - 1),
    label: NewSavedLabelSchema,
  })
  .strict();
export type SelectedLabel = z.infer<typeof SelectedLabelSchema>;
export type ApplicationLabel = z.infer<typeof ApplicationLabelSchema>;
const optionalLabel = {
  label: ApplicationLabelSchema.shape.label.optional(),
  labelSource: ApplicationLabelSchema.shape.labelSource.optional(),
};
const labelPair = (p: { label?: string; labelSource?: string }) =>
  (p.label === undefined) === (p.labelSource === undefined);
const OsmPlaceSchema = z
  .object({
    id: IdSchema,
    workspaceId: IdSchema,
    ...optionalLabel,
    canonicalName: z.string().min(1),
    nativeName: z.string().optional(),
    aliases: z.array(z.string()),
    category: z.string(),
    coordinates: CoordinatesSchema,
    address: AddressSchema,
    chainId: IdSchema.optional(),
    source: ReferenceSchema,
    evidence: z.array(ReferenceSchema).min(1),
    confidence: Confidence,
    status: z.enum(['confirmed', 'archived']),
    tags: z.array(z.string()),
    createdAt: Timestamp,
    updatedAt: Timestamp,
    attributions: AttributionsSchema.optional(),
  })
  .strict()
  .refine(labelPair);
// Application-owned map metadata. Every value is independent of the Google response:
// `user` city is the Discovery.cityOverride the user typed; `recognition` values come from
// our own Recognition clue. Google displayName/formattedAddress/types/district never enter.
const MAX_MAP_CITY = 200;
const MAX_MAP_CATEGORY = 100;
const mapMetadataText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((s) => !/[\u0000-\u001f\u007f]/u.test(s));
export const LocalityIdentitySchema = z
  .object({
    key: z.string().regex(/^google-locality:[a-f0-9]{64}$/),
    source: z.literal('google-places-locality'),
  })
  .strict();
export type LocalityIdentity = z.infer<typeof LocalityIdentitySchema>;
export const MapMetadataSchema = z
  .object({
    city: z
      .object({
        value: mapMetadataText(MAX_MAP_CITY),
        source: z.enum(['user', 'recognition']),
      })
      .strict()
      .optional(),
    locality: LocalityIdentitySchema.optional(),
    category: z
      .object({
        value: mapMetadataText(MAX_MAP_CATEGORY),
        source: z.enum(['recognition', 'user']),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((m) => m.city !== undefined || m.category !== undefined);
export type MapMetadata = z.infer<typeof MapMetadataSchema>;
// Google content is display-only. A durable Google Place retains identity and references,
// never provider display names, address, coordinates, types or attribution content.
export const GoogleIdentitySchema = z
  .object({
    provider: z.literal('google-places'),
    id: GooglePlaceIdSchema,
  })
  .strict();
const GooglePlaceSchema = z
  .object({
    id: IdSchema,
    workspaceId: IdSchema,
    ...optionalLabel,
    mapMetadata: MapMetadataSchema.optional(),
    providerIdentity: GoogleIdentitySchema,
    source: ReferenceSchema.refine(
      (r) => r.provider === 'google-places' && !!r.externalId,
    ),
    evidence: z.array(ReferenceSchema).min(1),
    status: z.enum(['confirmed', 'archived']),
    tags: z.array(z.string()),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .strict()
  .refine(labelPair)
  .refine((p) => p.source.externalId === p.providerIdentity.id);
export const PlaceSchema = z.union([
  GooglePlaceSchema,
  OsmPlaceSchema.refine((p) => p.source.provider !== 'google-places'),
]);
export const ChainSchema = z
  .object({
    id: IdSchema,
    canonicalName: z.string().min(1),
    nativeNames: z.array(z.string()),
    aliases: z.array(z.string()),
    category: z.string(),
    references: z.array(ReferenceSchema),
  })
  .strict();
export const WorkspaceSchema = z
  .object({
    id: IdSchema,
    members: z.array(z.string().min(1)),
    settings: z.object({ locale: z.string().default('en') }).strict(),
    areaHint: z.string().min(1).max(200).optional(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .strict();
// Vision never returns authoritative coordinates. This schema is shared by both AI adapters.
export const RecognitionSchema = z
  .object({
    mode: z
      .enum(['single_venue', 'recommendation_list', 'scene_viewpoint'])
      .optional(),
    scene: z
      .object({
        landmarks: z.array(z.string().trim().min(1).max(300)).min(1).max(3),
        cityHint: z.string().trim().min(1).max(200),
        countryCode: z
          .string()
          .regex(/^[A-Z]{2}$/)
          .optional(),
        context: z.enum(['waterfront', 'park', 'skyline', 'viewpoint']),
      })
      .strict()
      .optional(),
    recommendationsTruncated: z.boolean().optional(),
    visibleText: z.array(z.string()).max(100),
    clues: z
      .array(
        z
          .object({
            name: z.string().min(1).max(300),
            nativeName: z.string().optional(),
            aliases: z.array(z.string()).max(20),
            category: z.string(),
            recommendationEvidence: z
              .enum(['numbered_list', 'caption', 'editorial'])
              .optional(),
            possibleChain: z.string().min(1).max(100).optional(),
            signage: z
              .string()
              .min(1)
              .max(150)
              .refine((s) => !/[\u0000-\u001f\u007f]/u.test(s))
              .optional(),
            // Broader search locality (district, city, region) used to plan provider searches.
            areaHint: z.string().optional(),
            // The venue's city or municipality only; omitted unless the model is confident.
            // Optional so Recognition documents written before it existed still parse.
            cityHint: z.string().optional(),
            confidence: Confidence,
          })
          .strict(),
      )
      .max(10),
  })
  .strict()
  .refine(
    (r) =>
      r.mode !== 'recommendation_list' ||
      (r.clues.length >= 1 &&
        r.clues.length <= MAX_RECOMMENDATIONS &&
        r.clues.every((c) => !!c.recommendationEvidence && !c.signage) &&
        new Set(
          r.clues.map((c) =>
            c.name
              .normalize('NFKC')
              .toLowerCase()
              .replace(/[^\p{L}\p{N}]/gu, ''),
          ),
        ).size === r.clues.length),
    'invalid_recommendation_list',
  )
  .refine(
    (r) =>
      r.mode === 'scene_viewpoint'
        ? !!r.scene &&
          r.clues.length <= 3 &&
          r.clues.every((c) => !c.signage && !c.possibleChain)
        : r.scene === undefined,
    'invalid_scene_viewpoint',
  );
// Durable Recognition retains the historical ten-clue decoder. Fresh model
// output must have unambiguous mode semantics before it enters persistence/search.
export const FreshRecognitionSchema = RecognitionSchema.refine(
  (r) =>
    r.mode === 'recommendation_list' ||
    (r.clues.length <= 3 &&
      r.clues.every((c) => c.recommendationEvidence === undefined) &&
      r.recommendationsTruncated === undefined),
  'invalid_fresh_recognition_mode',
);
export const CandidateSchema = z
  .object({
    localityIdentity: LocalityIdentitySchema.optional(),
    recognitionClueIndex: z.number().int().min(0).max(9).optional(),
    canonicalName: z.string().min(1),
    nativeName: z.string().optional(),
    aliases: z.array(z.string()),
    category: z.string(),
    coordinates: CoordinatesSchema,
    address: AddressSchema,
    chainId: IdSchema.optional(),
    references: z.array(ReferenceSchema).min(1).max(25),
    resolution: z.literal('deterministic_poi'),
    providerIdentity: z
      .union([
        GoogleIdentitySchema,
        z
          .object({
            provider: z.string().min(1).max(64),
            id: z.string().min(1).max(128),
          })
          .strict()
          .refine((i) => i.provider !== 'google-places'),
      ])
      .optional(),
    confidence: Confidence,
    relationship: RelationshipSchema.optional(),
    candidateConfidence: z.enum(['high', 'medium', 'low']).optional(),
    attributions: AttributionsSchema.optional(),
  })
  .strict();
export const GoogleStoredCandidateSchema = z
  .object({
    localityIdentity: LocalityIdentitySchema.optional(),
    relationship: RelationshipSchema.optional(),
    candidateConfidence: z.enum(['high', 'medium', 'low']).optional(),
    recognitionClueIndex: z.number().int().min(0).max(9).optional(),
    resolution: z.literal('deterministic_poi'),
    providerIdentity: GoogleIdentitySchema,
    references: z.array(ReferenceSchema).min(1).max(25),
  })
  .strict()
  .refine((c) =>
    c.references.some(
      (r) =>
        r.provider === 'google-places' &&
        r.externalId === c.providerIdentity.id,
    ),
  );
export const StoredCandidateSchema = z.union([
  GoogleStoredCandidateSchema,
  CandidateSchema.refine(
    (c) =>
      c.providerIdentity?.provider !== 'google-places' &&
      !c.references.some((r) => r.provider === 'google-places'),
  ),
]);
export type StoredCandidate = z.infer<typeof StoredCandidateSchema>;
export function storedCandidate(candidate: Candidate): StoredCandidate {
  return StoredCandidateSchema.parse(
    candidate.providerIdentity?.provider === 'google-places'
      ? {
          ...(candidate.recognitionClueIndex !== undefined
            ? { recognitionClueIndex: candidate.recognitionClueIndex }
            : {}),
          ...(candidate.candidateConfidence
            ? { candidateConfidence: candidate.candidateConfidence }
            : {}),
          ...(candidate.relationship
            ? { relationship: candidate.relationship }
            : {}),
          ...(candidate.localityIdentity
            ? { localityIdentity: candidate.localityIdentity }
            : {}),
          resolution: candidate.resolution,
          providerIdentity: candidate.providerIdentity,
          references: candidate.references,
        }
      : candidate,
  );
}
// Provider display content is in-memory only; the application confidence enum may be retained on a Discovery.
export const PlaceDisplaySchema = CandidateSchema.pick({
  relationship: true,
  candidateConfidence: true,
  canonicalName: true,
  coordinates: true,
  address: true,
  providerIdentity: true,
  references: true,
  attributions: true,
});
export type PlaceDisplay = z.infer<typeof PlaceDisplaySchema>;
// Transient provider-neutral map projection; never a durable Place or Discovery.
export const ProjectedPlaceSchema = z
  .object({
    id: IdSchema,
    label: z.string().min(1),
    coordinates: CoordinatesSchema,
    tags: z.array(z.string()),
    category: z.string().optional(),
    city: z.string().min(1).optional(),
    cityKey: LocalityIdentitySchema.shape.key.optional(),
    // Independently licensed (OSM/Nominatim) formatted address only; never Google content.
    address: z.string().min(1).optional(),
    providerIdentity: z.union([
      GoogleIdentitySchema,
      z
        .object({ provider: z.string().min(1), id: z.string().min(1) })
        .strict()
        .refine((p) => p.provider !== 'google-places'),
    ]),
    sourceLink: z.string().url().optional(),
  })
  .strict()
  .refine(
    (p) =>
      p.providerIdentity.provider !== 'google-places' ||
      p.address === undefined,
    'google_address_forbidden',
  );
export type ProjectedPlace = z.infer<typeof ProjectedPlaceSchema>;
export const GeographicContextSchema = z
  .object({
    // The city the user typed ("Изменить город"). Always wins over inferredCity.
    cityOverride: z.string().min(1).max(200).optional(),
    // A search city inferred from Recognition (recommendationSearchCity), used only while the
    // user has not named one. Derived on every resolve, never persisted, never a cityOverride.
    inferredCity: z.string().min(1).max(200).optional(),
    workspaceAreaHint: z.string().min(1).max(200).optional(),
    selectedBrandIndices: z
      .array(
        z
          .number()
          .int()
          .min(0)
          .max(MAX_RECOMMENDATIONS - 1),
      )
      .max(MAX_SEARCH_BRANDS)
      .optional(),
    relatedRequested: z.boolean().optional(),
  })
  .strict();
export const ResolutionReasonSchema = z.enum([
  'missing_locality',
  'ambiguous_locality',
  'no_place_evidence',
  'insufficient_evidence',
  'no_match',
  'unsupported_category',
  'ambiguous_poi',
  'locality_conflict',
  'locality_mismatch',
]);
export const PoiResolutionSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('alternatives'),
      candidates: z
        .array(
          CandidateSchema.refine(
            (c) => c.providerIdentity?.provider === 'google-places',
          ),
        )
        .min(1)
        .max(MAX_CANDIDATES)
        .refine(
          (cs) =>
            new Set(cs.map((c) => c.providerIdentity?.id)).size === cs.length,
        ),
    })
    .strict(),
  z
    .object({ status: z.literal('resolved'), candidate: CandidateSchema })
    .strict(),
  z
    .object({
      status: z.literal('city_unknown'),
      reason: z.enum(['missing_locality', 'ambiguous_locality']),
    })
    .strict(),
  z
    .object({
      status: z.literal('unresolved'),
      reason: z.enum([
        'no_place_evidence',
        'insufficient_evidence',
        'no_match',
        'unsupported_category',
        'ambiguous_poi',
        'locality_conflict',
        'locality_mismatch',
      ]),
    })
    .strict(),
]);
export type GeographicContext = z.infer<typeof GeographicContextSchema>;
export type PoiResolution = z.infer<typeof PoiResolutionSchema>;
export const ProviderFailureReasonSchema = z.enum([
  'google_places_response_invalid',
  'google_places_top_level_invalid',
  'google_places_invalid_json',
  'google_places_response_too_large',
  'google_places_adaptation_failed',
  'poi_adaptation_failed',
]);
export type ProviderFailureReason = z.infer<typeof ProviderFailureReasonSchema>;
export const DiscoverySchema = z
  .object({
    id: IdSchema,
    workspaceId: IdSchema,
    source: ReferenceSchema,
    recognition: RecognitionSchema,
    candidates: z.array(StoredCandidateSchema).max(20),
    visionProvider: z.string(),
    status: z.enum([
      'needs_confirmation',
      'awaiting_brands',
      'needs_selection',
      'awaiting_city',
      'unresolved',
      'confirmed',
      'cancelled',
      'failed',
    ]),
    failureReason: ProviderFailureReasonSchema.optional(),
    relatedRequested: z.boolean().optional(),
    selectedBrandIndices: z
      .array(z.number().int().nonnegative())
      .max(MAX_SEARCH_BRANDS)
      .optional(),
    cityOverride: z.string().min(1).max(200).optional(),
    resolutionReason: ResolutionReasonSchema.optional(),
    revision: z.number().int().nonnegative().default(0),
    completionRequestId: IdSchema.optional(),
    completionLabels: z
      .array(SelectedLabelSchema)
      .max(MAX_CANDIDATES)
      .optional(),
    completionNewCount: z.number().int().min(0).max(MAX_CANDIDATES).optional(),
    completionReusedCount: z
      .number()
      .int()
      .min(0)
      .max(MAX_CANDIDATES)
      .optional(),
    inputDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    confirmedPlaceId: IdSchema.optional(),
    confirmedPlaceIds: z.array(IdSchema).min(1).max(MAX_CANDIDATES).optional(),
    selectedCandidateIndices: z
      .array(z.number().int().nonnegative())
      .max(MAX_CANDIDATES)
      .optional(),
    createdAt: Timestamp,
    updatedAt: Timestamp.optional(),
  })
  .strict()
  .refine(
    (d) =>
      d.status === 'failed'
        ? !!d.failureReason &&
          d.candidates.length === 0 &&
          !d.confirmedPlaceId &&
          !d.confirmedPlaceIds
        : d.failureReason === undefined,
    'invalid_terminal_failure_state',
  )
  .refine(
    (d) =>
      d.status !== 'needs_selection' ||
      (d.candidates.length >= 1 &&
        d.candidates.length <= MAX_CANDIDATES &&
        d.candidates.every(
          (c) => c.providerIdentity?.provider === 'google-places',
        )),
    'invalid_selection_state',
  )
  .refine(
    (d) =>
      (!d.selectedBrandIndices ||
        (d.recognition.mode === 'recommendation_list' &&
          new Set(d.selectedBrandIndices).size ===
            d.selectedBrandIndices.length &&
          d.selectedBrandIndices.every(
            (i) => i < d.recognition.clues.length,
          ))) &&
      (d.status !== 'awaiting_brands' ||
        (d.recognition.mode === 'recommendation_list' &&
          d.candidates.length === 0)),
    'invalid_brand_selection',
  )
  .refine(
    (d) =>
      !d.selectedCandidateIndices ||
      (new Set(d.selectedCandidateIndices).size ===
        d.selectedCandidateIndices.length &&
        d.selectedCandidateIndices.every((i) => i < d.candidates.length)),
    'invalid_selection_indices',
  )
  .refine(
    (d) =>
      !d.confirmedPlaceIds ||
      (new Set(d.confirmedPlaceIds).size === d.confirmedPlaceIds.length &&
        (!d.confirmedPlaceId || d.confirmedPlaceIds[0] === d.confirmedPlaceId)),
    'invalid_confirmed_ids',
  );
export type Place = z.infer<typeof PlaceSchema>;
export type Chain = z.infer<typeof ChainSchema>;
export type Workspace = z.infer<typeof WorkspaceSchema>;
export type Recognition = z.infer<typeof RecognitionSchema>;
export type Candidate = z.infer<typeof CandidateSchema>;
export type Discovery = z.infer<typeof DiscoverySchema>;
export type DiscoveryView = Discovery & {
  liveCandidate?: Candidate;
  liveAlternatives?: Candidate[];
};
export type Reference = z.infer<typeof ReferenceSchema>;

// No coordinates or model-supplied URLs in textual verification output.
export const VerifiedTextSchema = z
  .object({
    canonicalName: z.string().min(1).max(300),
    nativeName: z.string().min(1).max(300).optional(),
    aliases: z.array(z.string().min(1).max(300)).max(10),
    category: z.string().min(1).max(100),
    city: z.string().min(1).max(200).optional(),
    cityAliases: z.array(z.string().min(1).max(200)).max(10).default([]),
    countryCode: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
    district: z.string().min(1).max(200).optional(),
    country: z.string().min(1).max(100).optional(),
    addressClue: z.string().min(1).max(300).optional(),
    confidence: Confidence,
  })
  .strict();
export const LocalityIntentSchema = z
  .object({
    canonicalName: z.string().min(1).max(200),
    aliases: z.array(z.string().min(1).max(200)).max(10),
    countryCode: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
    confidence: Confidence,
  })
  .strict();
export const VerificationSchema = z
  .object({
    status: z.enum(['verified', 'unavailable', 'no_evidence']),
    localityIntent: LocalityIntentSchema.extend({
      input: z.string().min(1).max(200),
    }).optional(),
    candidates: z.array(VerifiedTextSchema).max(3),
    references: z.array(ReferenceSchema).max(20),
  })
  .strict();
export type Verification = z.infer<typeof VerificationSchema>;

// The single clue-association rule shared by labels and map metadata: an explicit bound
// index, or the only clue of a single-clue Recognition. Multiple unbound clues are ambiguous.
export function recognitionClue(recognition: Recognition, index?: number) {
  const selected = index ?? (recognition.clues.length === 1 ? 0 : undefined);
  return selected === undefined ? undefined : recognition.clues[selected];
}
const singleLine = (text: string) =>
  text
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
// This function reads independent Recognition only, never provider display or verification.
export function recognitionLabel(
  recognition: Recognition,
  index?: number,
): ApplicationLabel | undefined {
  const name = recognitionClue(recognition, index)?.name;
  if (!name) return;
  const parsed = ApplicationLabelSchema.safeParse({
    label: singleLine(name),
    labelSource: 'recognition',
  });
  return parsed.success ? parsed.data : undefined;
}
const metadataValue = (text: string | undefined, max: number) => {
  const value = text === undefined ? '' : singleLine(text);
  return value && value.length <= max ? value : undefined;
};
// The confidence at and above which a Recognition clue's locality hint is trusted
// (selectLocality's `vision` locality uses the same threshold for areaHint; recognitionCity
// uses it for cityHint).
export const RECOGNITION_LOCALITY_MIN_CONFIDENCE = 0.85;
// A hint naming alternatives ("Shanghai or Hangzhou", "Shanghai / Suzhou") is not one city.
const ALTERNATIVE_LOCALITIES = /[;|/\\]|\s(?:or|или)\s|或/iu;
const sameLocality = (a: string, b: string) =>
  a.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim() ===
  b.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();

// A deterministic, unambiguous Recognition city for the bound clue, or undefined. It reads the
// dedicated cityHint (a city or municipality) only, never the broader search areaHint:
//  - the clue is bound deterministically (recognitionClue: explicit index or the only clue);
//  - its confidence reaches RECOGNITION_LOCALITY_MIN_CONFIDENCE;
//  - its cityHint is one single-line city, not a list of alternatives;
//  - in a single-venue Recognition (clues are alternative readings of ONE venue) every other
//    confident clue that carries a cityHint names the same city; a recommendation list's
//    clues are different venues, so each confident clue's own hint stands for its own venue.
// The value is the Recognition's own text, kept as written (never reshaped from an address).
export function recognitionCity(
  recognition: Recognition,
  index?: number,
): string | undefined {
  const clue = recognitionClue(recognition, index);
  if (!clue || clue.confidence < RECOGNITION_LOCALITY_MIN_CONFIDENCE) return;
  const hint = metadataValue(clue.cityHint, MAX_MAP_CITY);
  if (!hint || ALTERNATIVE_LOCALITIES.test(hint)) return;
  if (recognition.mode !== 'recommendation_list') {
    const conflicting = recognition.clues.some((other) => {
      if (
        other === clue ||
        other.confidence < RECOGNITION_LOCALITY_MIN_CONFIDENCE
      )
        return false;
      const otherHint = metadataValue(other.cityHint, MAX_MAP_CITY);
      return otherHint !== undefined && !sameLocality(otherHint, hint);
    });
    if (conflicting) return;
  }
  return hint;
}

// The city a recommendation-list search uses when the user has not named one: the shared
// deterministic Recognition cityHint (recognitionCity) of EVERY selected recommendation, or
// undefined, which means the user is asked. Only the selected clues count; an unselected or
// related recommendation never does. A selected clue without a usable cityHint leaves its
// venue's city unknown, and two different cities are ambiguous, so both ask. areaHint is never
// read. The result is an inferred search locality, never written to cityOverride.
export function recommendationSearchCity(
  recognition: Recognition,
  selectedBrandIndices: readonly number[] | undefined,
): string | undefined {
  if (
    recognition.mode !== 'recommendation_list' ||
    !selectedBrandIndices?.length
  )
    return;
  let city: string | undefined;
  for (const index of selectedBrandIndices) {
    if (!recognition.clues[index]) return;
    const hint = recognitionCity(recognition, index);
    if (!hint || (city !== undefined && !sameLocality(city, hint))) return;
    city ??= hint;
  }
  return city;
}

// Map metadata for one confirmed candidate, from application-owned inputs only. The candidate
// is the durable stored form (a Google stored candidate has no provider display fields), so
// Google address/city/types are structurally unreachable here; this function never reads a
// candidate address, a Verification candidate city or any provider response.
//   city:     Discovery.cityOverride (user) first, when both exist; otherwise the bound clue's
//             deterministic, unambiguous Recognition cityHint (recognitionCity,
//             `recognition`), and only for the photographed venue itself, never a related branch.
//             The broader search areaHint is never a city.
//   category: the bound clue's own category (recognition); a related branch of the same
//             deterministic clue may inherit it, because it describes the same brand.
export function mapMetadataFor(
  discovery: Pick<Discovery, 'recognition' | 'cityOverride'>,
  candidate: {
    recognitionClueIndex?: number;
    relationship?: string;
    localityIdentity?: LocalityIdentity;
  },
): MapMetadata | undefined {
  const related = candidate.relationship?.startsWith('related_') ?? false;
  const clue = recognitionClue(
    discovery.recognition,
    candidate.recognitionClueIndex,
  );
  const userCity = metadataValue(discovery.cityOverride, MAX_MAP_CITY);
  const boundCity = related
    ? undefined
    : (discovery.recognition.scene?.cityHint ??
      recognitionCity(discovery.recognition, candidate.recognitionClueIndex));
  const category = metadataValue(
    clue?.category ?? discovery.recognition.scene?.context,
    MAX_MAP_CATEGORY,
  );
  const parsed = MapMetadataSchema.safeParse({
    ...((userCity || boundCity) && candidate.localityIdentity
      ? { locality: candidate.localityIdentity }
      : {}),
    ...(userCity
      ? { city: { value: userCity, source: 'user' } }
      : boundCity
        ? { city: { value: boundCity, source: 'recognition' } }
        : {}),
    ...(category
      ? { category: { value: category, source: 'recognition' } }
      : {}),
  });
  return parsed.success ? parsed.data : undefined;
}

// Enrichment of an already stored Place: the derived application-owned metadata fills ONLY the
// fields the Place does not have yet. An existing city or category is never overwritten,
// whatever its source. Returns the merged metadata, or undefined when nothing is missing.
export function fillMissingMapMetadata(
  existing: MapMetadata | undefined,
  derived: MapMetadata | undefined,
): MapMetadata | undefined {
  if (!derived) return;
  const city = existing?.city ? undefined : derived.city;
  const category = existing?.category ? undefined : derived.category;
  const locality =
    existing?.locality ||
    (existing?.city && existing.city.value !== derived.city?.value)
      ? undefined
      : derived.locality;
  if (!city && !category && !locality) return;
  return MapMetadataSchema.parse({
    ...(existing ?? {}),
    ...(locality ? { locality } : {}),
    ...(city ? { city } : {}),
    ...(category ? { category } : {}),
  });
}
