import { z } from 'zod';
export const IdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const Timestamp = z.string().datetime();
const Confidence = z.number().min(0).max(1);
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
export const PlaceSchema = z
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
  })
  .strict();
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
    members: z.array(z.string().min(1)).min(1),
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
    references: z.array(ReferenceSchema).min(1),
    confidence: Confidence,
  })
  .strict();
export const DiscoverySchema = z
  .object({
    id: IdSchema,
    workspaceId: IdSchema,
    source: ReferenceSchema,
    recognition: RecognitionSchema,
    candidates: z.array(CandidateSchema).max(20),
    visionProvider: z.string(),
    status: z.literal('needs_confirmation'),
    createdAt: Timestamp,
  })
  .strict();
export type Place = z.infer<typeof PlaceSchema>;
export type Chain = z.infer<typeof ChainSchema>;
export type Workspace = z.infer<typeof WorkspaceSchema>;
export type Recognition = z.infer<typeof RecognitionSchema>;
export type Candidate = z.infer<typeof CandidateSchema>;
export type Discovery = z.infer<typeof DiscoverySchema>;
export type Reference = z.infer<typeof ReferenceSchema>;
