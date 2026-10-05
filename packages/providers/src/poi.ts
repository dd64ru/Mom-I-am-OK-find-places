import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  CandidateSchema,
  type Candidate,
  type Recognition,
  type Verification,
} from '@places/schemas';
import type { PoiProvider } from '@places/core';
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
    country: z.string().optional(),
    country_code: z
      .string()
      .regex(/^[a-z]{2}$/)
      .optional(),
  }),
  namedetails: z.record(z.string()).optional(),
});
const normalized = (s: string) =>
  s.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ');
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
    areaHint?: string,
  ): Promise<Candidate[]> {
    const verified =
      verification.status === 'verified' && verification.references.length
        ? verification.candidates.filter((c) => c.confidence >= 0.8)
        : [];
    if (verified.length > 1) return []; // do not arbitrarily choose a textual candidate
    const highVision = recognition.clues.filter((c) => c.confidence >= 0.85);
    if (!verified.length && highVision.length !== 1) return [];
    const clue = verified[0] ?? highVision[0];
    if (!clue) return [];
    const city =
      areaHint ?? ('canonicalName' in clue ? clue.city : clue.areaHint);
    if (!city) return [];
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
      .update(`${this.endpoint}:${normalized(query)}`)
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
          }).toString();
          const response = await this.request(url, {
            headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
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
      for (const row of rows) {
        if (
          !['amenity', 'shop', 'tourism', 'leisure', 'historic'].includes(
            row.category,
          )
        )
          continue;
        const names = [row.name, ...Object.values(row.namedetails ?? {})];
        if (
          !names.some((n) =>
            aliases.some((a) => normalized(a) === normalized(n)),
          )
        )
          continue;
        const areas = [
          row.address.city,
          row.address.town,
          row.address.village,
          row.address.municipality,
          row.address.county,
          row.address.state,
          row.address.country,
        ].filter((s): s is string => !!s);
        if (!areas.some((a) => normalized(city) === normalized(a))) continue;
        const externalId = `${row.osm_type}/${row.osm_id}`;
        const reference = {
          provider: 'nominatim',
          externalId,
          url: `https://www.openstreetmap.org/${externalId}`,
          observedAt: new Date(this.now()).toISOString(),
        };
        results.push(
          CandidateSchema.parse({
            canonicalName: row.name,
            ...(clue.nativeName ? { nativeName: clue.nativeName } : {}),
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
      return results;
    } catch {
      throw new Error('poi_result_invalid');
    }
  }
}
