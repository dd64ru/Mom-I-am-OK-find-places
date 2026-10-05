import { z } from 'zod';
export const IdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const Timestamp = z.string().datetime();
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
    district: z.string().optional(),
  })
  .strict();
const OsmPlaceSchema = z
  .object({
    id: IdSchema,
    workspaceId: IdSchema,
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
  .strict();
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
    visibleText: z.array(z.string()).max(100),
    clues: z
      .array(
        z
          .object({
            name: z.string().min(1).max(300),
            nativeName: z.string().optional(),
            aliases: z.array(z.string()).max(20),
            category: z.string(),
            possibleChain: z.string().optional(),
            areaHint: z.string().optional(),
            confidence: Confidence,
          })
          .strict(),
      )
      .max(10),
  })
  .strict();
export const CandidateSchema = z
  .object({
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
    attributions: AttributionsSchema.optional(),
  })
  .strict();
export const GoogleStoredCandidateSchema = z
  .object({
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
          resolution: candidate.resolution,
          providerIdentity: candidate.providerIdentity,
          references: candidate.references,
        }
      : candidate,
  );
}
// Only for in-memory rendering/projection; never a Firestore Place or Discovery field.
export const PlaceDisplaySchema = CandidateSchema.pick({
  canonicalName: true,
  coordinates: true,
  address: true,
  providerIdentity: true,
  references: true,
  attributions: true,
});
export type PlaceDisplay = z.infer<typeof PlaceDisplaySchema>;
export const GeographicContextSchema = z
  .object({
    cityOverride: z.string().min(1).max(200).optional(),
    workspaceAreaHint: z.string().min(1).max(200).optional(),
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
      'awaiting_city',
      'unresolved',
      'confirmed',
      'cancelled',
      'failed',
    ]),
    failureReason: ProviderFailureReasonSchema.optional(),
    cityOverride: z.string().min(1).max(200).optional(),
    resolutionReason: ResolutionReasonSchema.optional(),
    revision: z.number().int().nonnegative().default(0),
    confirmedPlaceId: IdSchema.optional(),
    createdAt: Timestamp,
    updatedAt: Timestamp.optional(),
  })
  .strict()
  .refine(
    (d) =>
      d.status === 'failed'
        ? !!d.failureReason && d.candidates.length === 0 && !d.confirmedPlaceId
        : d.failureReason === undefined,
    'invalid_terminal_failure_state',
  );
export type Place = z.infer<typeof PlaceSchema>;
export type Chain = z.infer<typeof ChainSchema>;
export type Workspace = z.infer<typeof WorkspaceSchema>;
export type Recognition = z.infer<typeof RecognitionSchema>;
export type Candidate = z.infer<typeof CandidateSchema>;
export type Discovery = z.infer<typeof DiscoverySchema>;
export type DiscoveryView = Discovery & { liveCandidate?: Candidate };
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
