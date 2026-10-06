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
    labelSource: z.enum(['recognition', 'user']),
  })
  .strict();
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
    mode: z.enum(['single_venue', 'recommendation_list']).optional(),
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
            areaHint: z.string().optional(),
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
    providerIdentity: z.union([
      GoogleIdentitySchema,
      z
        .object({ provider: z.string().min(1), id: z.string().min(1) })
        .strict()
        .refine((p) => p.provider !== 'google-places'),
    ]),
    sourceLink: z.string().url().optional(),
  })
  .strict();
export type ProjectedPlace = z.infer<typeof ProjectedPlaceSchema>;
export const GeographicContextSchema = z
  .object({
    cityOverride: z.string().min(1).max(200).optional(),
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

// This function reads independent Recognition only, never provider display or verification.
export function recognitionLabel(
  recognition: Recognition,
  index?: number,
): ApplicationLabel | undefined {
  const selected = index ?? (recognition.clues.length === 1 ? 0 : undefined);
  if (selected === undefined) return;
  const name = recognition.clues[selected]?.name;
  if (!name) return;
  const parsed = ApplicationLabelSchema.safeParse({
    label: name
      .replace(/[\u0000-\u001f\u007f]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim(),
    labelSource: 'recognition',
  });
  return parsed.success ? parsed.data : undefined;
}
