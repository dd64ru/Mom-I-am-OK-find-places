import { z } from 'zod';
import { CoordinatesSchema, GooglePlaceIdSchema } from '@places/schemas';
// External DTOs intentionally strip unknown fields and have no guessed field/count limits.
const ComponentDto = z.object({
  longText: z.string().optional(),
  shortText: z.string().optional(),
  types: z.array(z.string()).optional(),
});
const AttributionDto = z.object({
  provider: z.string().optional(),
  providerUri: z.string().optional(),
});
const PlaceDto = z.object({
  id: z.string().optional(),
  displayName: z.object({ text: z.string().optional() }).optional(),
  formattedAddress: z.string().optional(),
  types: z.array(z.string()).optional(),
  addressComponents: z.array(ComponentDto).optional(),
  attributions: z.array(AttributionDto).optional(),
});
export const GOOGLE_BODY_LIMIT = 8 * 1024 * 1024;
export const rowCodes = [
  'missing_id',
  'missing_display_name',
  'missing_location',
  'invalid_location',
  'unsupported_shape',
] as const;
export type RowCode = (typeof rowCodes)[number];
export type GoogleParseEvent = {
  event: 'google_places_parse';
  topLevel: 'ok' | 'top_level_invalid' | 'response_too_large' | 'invalid_json';
  rowsReturned: number;
  rowsUsable: number;
  rowsSkipped: number;
  skipped: Record<RowCode, number>;
};
export const parseCounts = (): Record<RowCode, number> => ({
  missing_id: 0,
  missing_display_name: 0,
  missing_location: 0,
  invalid_location: 0,
  unsupported_shape: 0,
});
export type GooglePlaceDto = {
  id: string;
  displayName: { text: string };
  location: { latitude: number; longitude: number };
  formattedAddress?: string;
  types: string[];
  addressComponents: {
    longText?: string;
    shortText?: string;
    types: string[];
  }[];
  attributions?: { provider: string; providerUri?: string }[];
};
export function adaptGoogleRow(
  raw: unknown,
  credential?: string,
): { row: GooglePlaceDto; code: 'usable' } | { code: RowCode } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { code: 'unsupported_shape' };
  const r = raw as Record<string, unknown>;
  if (!GooglePlaceIdSchema.safeParse(r.id).success)
    return { code: 'missing_id' };
  if (
    !r.displayName ||
    typeof r.displayName !== 'object' ||
    typeof (r.displayName as { text?: unknown }).text !== 'string' ||
    !(r.displayName as { text: string }).text.trim()
  )
    return { code: 'missing_display_name' };
  if (!r.location) return { code: 'missing_location' };
  const l = r.location as { latitude?: unknown; longitude?: unknown };
  const coordinates = CoordinatesSchema.safeParse({
    latitude: l.latitude,
    longitude: l.longitude,
    crs: 'WGS84',
  });
  if (!coordinates.success) return { code: 'invalid_location' };
  const parsed = PlaceDto.safeParse(raw);
  if (!parsed.success) return { code: 'unsupported_shape' };
  const dto = parsed.data;
  const row: GooglePlaceDto = {
    id: dto.id!,
    displayName: { text: dto.displayName!.text! },
    location: {
      latitude: coordinates.data.latitude,
      longitude: coordinates.data.longitude,
    },
    ...(dto.formattedAddress !== undefined
      ? { formattedAddress: dto.formattedAddress }
      : {}),
    types: dto.types ?? [],
    addressComponents: (dto.addressComponents ?? []).map((c) => ({
      ...c,
      types: c.types ?? [],
    })),
    ...(dto.attributions
      ? {
          attributions: dto.attributions.map((a) => ({
            provider: a.provider || 'Поставщик данных',
            ...(a.providerUri !== undefined
              ? { providerUri: a.providerUri }
              : {}),
          })),
        }
      : {}),
  };
  // Only consumed fields are checked for unexpected credential echoes; unknown external fields are ignored.
  if (credential && JSON.stringify(row).includes(credential))
    return { code: 'unsupported_shape' };
  return { row, code: 'usable' };
}
export function searchEnvelope(
  raw: unknown,
): { places: unknown[]; nextPageToken?: string } | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const r = raw as Record<string, unknown>;
  if (
    (r.places !== undefined && !Array.isArray(r.places)) ||
    (r.nextPageToken !== undefined && typeof r.nextPageToken !== 'string')
  )
    return;
  return {
    places: (r.places as unknown[] | undefined) ?? [],
    ...(typeof r.nextPageToken === 'string'
      ? { nextPageToken: r.nextPageToken }
      : {}),
  };
}
