import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  CandidateSchema,
  GeographicContextSchema,
  VerificationSchema,
  RecognitionSchema,
  type GeographicContext,
  type PoiResolution,
  type Candidate,
  type Recognition,
  type Verification,
} from '@places/schemas';
import type { PoiProvider } from '@places/core';
import { selectLocality, localityMatches, normalizedName } from './locality.js';
import { travelPoi } from './travel-poi.js';
import type { AtomicDocuments } from './lease.js';
export const NOMINATIM_ENDPOINT = 'https://nominatim.openstreetmap.org';
const USER_AGENT =
  'Mom-I-am-OK-Places/0.0.1 (+https://github.com/dd64ru/Mom-I-am-OK-find-places)';
const Row = z.object({
  osm_type: z.enum(['node', 'way', 'relation']),
  osm_id: z.number().int().positive().safe(),
  lat: z.string().regex(/^-?\d+(?:\.\d+)?$/),
  lon: z.string().regex(/^-?\d+(?:\.\d+)?$/),
  name: z.string().min(1).max(300),
  display_name: z.string().min(1).max(1000),
  category: z.string().max(100),
  type: z.string().max(100),
  address: z.object({
    city: z.string().optional(),
    town: z.string().optional(),
    village: z.string().optional(),
    municipality: z.string().optional(),
    county: z.string().optional(),
    state: z.string().optional(),
    suburb: z.string().optional(),
    'ISO3166-2-lvl4': z.string().max(32).optional(),
    country: z.string().optional(),
    country_code: z
      .string()
      .regex(/^[a-z]{2}$/)
      .optional(),
  }),
  namedetails: z.record(z.string().max(300)).optional(),
});
export function nominatimEndpoint(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new Error('poi_endpoint_invalid');
  }
}
export class NominatimPoi implements PoiProvider {
  private readonly endpoint: string;
  constructor(
    private readonly docs: AtomicDocuments,
    endpoint = NOMINATIM_ENDPOINT,
    private readonly now = Date.now,
    private readonly request: typeof fetch = fetch,
  ) {
    this.endpoint = nominatimEndpoint(endpoint);
  }
  async resolve(
    recognition: Recognition,
    verification: Verification,
    context: GeographicContext = {},
  ): Promise<PoiResolution> {
    context = GeographicContextSchema.parse(context);
    verification = VerificationSchema.parse(verification);
    recognition = RecognitionSchema.parse(recognition);
    const decision = selectLocality(recognition, verification, context);
    if (decision.status !== 'ready') return decision;
    const { clue, locality } = decision;
    const city = locality.name;
    const name = 'canonicalName' in clue ? clue.canonicalName : clue.name;
    const aliases = [name, clue.nativeName, ...clue.aliases]
      .filter((s): s is string => !!s)
      .slice(0, 12);
    const query = [
      clue.nativeName ?? name,
      city,
      'addressClue' in clue ? clue.addressClue : undefined,
    ]
      .filter(Boolean)
      .join(', ')
      .slice(0, 500);
    // Only public venue name/area/address clues. Never images, visibleText, captions or conversation.
    const hash = createHash('sha256')
      .update(
        `${this.endpoint}:en:${locality.countryCode ?? ''}:${normalizedName(query)}`,
      )
      .digest('hex');
    const path = `_poiCache/${hash}`;
    const cached = await this.docs.change(path, (state) => ({
      result:
        state && Number(state.expiresAt) > this.now() ? state.rows : undefined,
    }));
    let raw: unknown = cached;
    if (raw === undefined) {
      const owner = randomUUID(),
        day = Math.floor(this.now() / 86_400_000);
      await this.docs.change('_runtime/nominatim-gate', (state) => {
        if (
          Number(state?.expiresAt ?? 0) > this.now() ||
          Number(state?.nextAt ?? 0) > this.now()
        )
          throw new Error('poi_rate_busy');
        const count = state?.day === day ? Number(state.count ?? 0) : 0;
        if (count >= 50) throw new Error('poi_daily_limit');
        return {
          value: {
            owner,
            expiresAt: this.now() + 30_000,
            nextAt: this.now() + 1500,
            day,
            count: count + 1,
          },
          result: undefined,
        };
      });
      try {
        // Recheck after global claim so concurrent identical queries share a completed cache.
        raw = await this.docs.change(path, (state) => ({
          result:
            state && Number(state.expiresAt) > this.now()
              ? state.rows
              : undefined,
        }));
        if (raw === undefined) {
          const url = new URL('/search', this.endpoint);
          url.search = new URLSearchParams({
            q: query,
            format: 'jsonv2',
            addressdetails: '1',
            namedetails: '1',
            limit: '3',
            dedupe: '1',
            'accept-language': 'en',
            ...(locality.countryCode
              ? { countrycodes: locality.countryCode.toLowerCase() }
              : {}),
          }).toString();
          const response = await this.request(url, {
            headers: {
              'User-Agent': USER_AGENT,
              Accept: 'application/json',
              'Accept-Language': 'en',
            },
            signal: AbortSignal.timeout(10_000),
            redirect: 'error',
          });
          if (!response.ok || !response.body) throw new Error();
          const reader = response.body.getReader();
          let size = 0;
          const chunks: Uint8Array[] = [];
          try {
            while (true) {
              const c = await reader.read();
              if (c.done) break;
              size += c.value.length;
              if (size > 100_000) throw new Error();
              chunks.push(c.value);
            }
          } finally {
            await reader.cancel();
            reader.releaseLock();
          }
          raw = z
            .array(Row)
            .max(3)
            .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          await this.docs.change('_runtime/nominatim-gate', (state) => {
            if (state?.owner !== owner || Number(state.expiresAt) <= this.now())
              throw new Error('poi_lease_lost');
            return { result: undefined };
          });
          await this.docs.change(path, () => ({
            value: { rows: raw, expiresAt: this.now() + 7 * 86_400_000 },
            result: undefined,
          }));
        }
      } catch {
        throw new Error('poi_lookup_failed');
      } finally {
        await this.docs.change('_runtime/nominatim-gate', (state) =>
          state?.owner === owner
            ? {
                value: { ...state, expiresAt: 0, nextAt: this.now() + 1500 },
                result: undefined,
              }
            : { result: undefined },
        );
      }
    }
    try {
      const rows = z.array(Row).max(3).parse(raw);
      const results: Candidate[] = [];
      let nameMatched = false,
        categoryMatched = false;
      for (const row of rows) {
        const names = [row.name, ...Object.values(row.namedetails ?? {})];
        if (
          !names.some((n) =>
            aliases.some((a) => normalizedName(a) === normalizedName(n)),
          )
        )
          continue;
        nameMatched = true;
        if (!travelPoi(row.category, row.type)) continue;
        categoryMatched = true;
        if (!localityMatches(row.address, locality)) continue;
        const externalId = `${row.osm_type}/${row.osm_id}`;
        const reference = {
          provider: 'nominatim',
          externalId,
          url: `https://www.openstreetmap.org/${externalId}`,
          observedAt: new Date(this.now()).toISOString(),
        };
        const canonicalName = row.namedetails?.['name:en']?.trim() || row.name;
        const nativeName =
          clue.nativeName ??
          (row.address.country_code === 'cn'
            ? row.namedetails?.['name:zh']
            : undefined) ??
          row.namedetails?.name ??
          row.name;
        results.push(
          CandidateSchema.parse({
            canonicalName,
            ...(nativeName && nativeName !== canonicalName
              ? { nativeName }
              : {}),
            aliases: clue.aliases,
            category: row.type,
            coordinates: {
              latitude: Number(row.lat),
              longitude: Number(row.lon),
              crs: 'WGS84',
            },
            address: {
              formatted: row.display_name,
              ...(row.address.country_code
                ? { countryCode: row.address.country_code.toUpperCase() }
                : {}),
              city: row.address.city ?? row.address.town ?? row.address.village,
              district: row.address.suburb,
            },
            references: [...verification.references, reference],
            confidence: clue.confidence,
            resolution: 'deterministic_poi',
            providerIdentity: { provider: 'nominatim', id: externalId },
          }),
        );
      }
      if (results.length === 1)
        return { status: 'resolved', candidate: results[0]! };
      if (results.length > 1)
        return { status: 'unresolved', reason: 'ambiguous_poi' };
      if (nameMatched && !categoryMatched)
        return { status: 'unresolved', reason: 'unsupported_category' };
      if (categoryMatched)
        return locality.source === 'vision'
          ? { status: 'city_unknown', reason: 'ambiguous_locality' }
          : { status: 'unresolved', reason: 'locality_mismatch' };
      return { status: 'unresolved', reason: 'no_match' };
    } catch {
      throw new Error('poi_result_invalid');
    }
  }
}
