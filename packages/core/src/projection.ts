import {
  CoordinatesSchema,
  ProjectedPlaceSchema,
  type ProjectedPlace,
  PlaceSchema,
  type PlaceDisplay,
} from '@places/schemas';
import { standardWgs84Position } from './map-alignment.js';
export { ProjectedPlaceSchema, type ProjectedPlace } from '@places/schemas';
export type ProjectionCounts = {
  placesTotal: number;
  placesProjected: number;
  googleHydrated: number;
  providerFailures: number;
  missingLabels: number;
  invalidPlaces: number;
  budgetSkipped: number;
};
export const MAX_PROJECTION_PLACES = 100;
export type CoordinateHydrator = {
  refresh(identity: { provider: string; id: string }): Promise<PlaceDisplay>;
};
export function bounded<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('projection_timeout')),
      timeoutMs,
    );
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        reject(new Error('projection_dependency_failed'));
      },
    );
  });
}
export class ProjectionService {
  constructor(
    private readonly hydrator: CoordinateHydrator,
    private readonly options: {
      concurrency?: number;
      refreshTimeoutMs?: number;
      budgetMs?: number;
      now?: () => number;
    } = {},
  ) {}
  async project(
    input: readonly unknown[],
  ): Promise<{ places: ProjectedPlace[]; counts: ProjectionCounts }> {
    if (input.length > MAX_PROJECTION_PLACES)
      throw new Error('projection_limit_exceeded');
    const counts: ProjectionCounts = {
      placesTotal: input.length,
      placesProjected: 0,
      googleHydrated: 0,
      providerFailures: 0,
      missingLabels: 0,
      invalidPlaces: 0,
      budgetSkipped: 0,
    };
    const output: ProjectedPlace[] = [];
    const ordered = input
      .flatMap((raw) => {
        const parsed = PlaceSchema.safeParse(raw);
        if (!parsed.success) {
          counts.invalidPlaces++;
          return [];
        }
        return [parsed.data];
      })
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const now = this.options.now ?? Date.now;
    const deadline =
      now() + Math.max(1, Math.min(30_000, this.options.budgetMs ?? 30_000));
    const concurrency = Math.max(
      1,
      Math.min(4, Math.floor(this.options.concurrency ?? 4)),
    );
    const refreshTimeout = Math.max(
      1,
      Math.min(10_000, this.options.refreshTimeoutMs ?? 10_000),
    );
    let cursor = 0;
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (cursor < ordered.length) {
          const place = ordered[cursor++]!;
          if (place.status !== 'confirmed') continue;
          const google = 'providerIdentity' in place;
          if (
            !google &&
            !['nominatim', 'osm'].includes(place.source.provider)
          ) {
            counts.invalidPlaces++;
            continue;
          }
          const label =
            place.label ?? (google ? 'Saved location' : place.canonicalName);
          // This neutral application text exists only in the projection. A Google
          // identity needs no durable name and no provider display content is copied.
          if (!label) {
            counts.missingLabels++;
            continue;
          }
          if (google) {
            const remaining = deadline - now();
            if (remaining <= 0) {
              counts.budgetSkipped++;
              continue;
            }
            try {
              const view = await bounded(
                this.hydrator.refresh(place.providerIdentity),
                Math.min(refreshTimeout, remaining),
              );
              // Consume only identity and coordinates. Display/address/category/credits are ignored.
              if (
                view.providerIdentity?.provider !== 'google-places' ||
                view.providerIdentity.id !== place.providerIdentity.id
              )
                throw new Error('projection_identity_mismatch');
              // The Places API location is WGS84 (GooglePlacesPoi states it) but aligned to
              // Google's map data: inside mainland China that data is GCJ-02-offset, so the
              // point is corrected once, here, to its position on a standard WGS84 map.
              // Elsewhere (Hong Kong, Macao and Taiwan included) it is unchanged.
              const acquired = CoordinatesSchema.parse(view.coordinates);
              const coordinates = CoordinatesSchema.parse({
                ...standardWgs84Position(acquired, 'google-mainland'),
                crs: acquired.crs,
              });
              // city/category come only from application-owned mapMetadata; a Google
              // feature never carries an address.
              output.push(
                ProjectedPlaceSchema.parse({
                  id: place.id,
                  label,
                  coordinates,
                  tags: [...place.tags],
                  ...(place.mapMetadata?.city
                    ? { city: place.mapMetadata.city.value }
                    : {}),
                  ...(place.mapMetadata?.locality
                    ? { cityKey: place.mapMetadata.locality.key }
                    : {}),
                  ...(place.mapMetadata?.category
                    ? { category: place.mapMetadata.category.value }
                    : {}),
                  providerIdentity: place.providerIdentity,
                }),
              );
              counts.googleHydrated++;
            } catch {
              counts.providerFailures++;
            }
          } else {
            output.push(
              ProjectedPlaceSchema.parse({
                id: place.id,
                label,
                // Stored OSM/Nominatim coordinates are standard-wgs84: emitted unchanged.
                coordinates: place.coordinates,
                category: place.category,
                // Independently licensed OSM/Nominatim address, exposed with OSM attribution.
                ...(place.address.city?.trim()
                  ? { city: place.address.city.trim() }
                  : {}),
                ...(place.address.formatted.trim()
                  ? { address: place.address.formatted.trim() }
                  : {}),
                tags: [...place.tags],
                providerIdentity: {
                  provider: place.source.provider,
                  id: place.source.externalId ?? place.id,
                },
                ...(place.source.url ? { sourceLink: place.source.url } : {}),
              }),
            );
          }
        }
      }),
    );
    output.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    counts.placesProjected = output.length;
    return { places: output, counts };
  }
}
export type ProjectionFormat = 'geojson' | 'gpx' | 'kml';
export const PROJECTION_CONTENT_TYPES: Record<ProjectionFormat, string> = {
  geojson: 'application/geo+json',
  gpx: 'application/gpx+xml',
  kml: 'application/vnd.google-earth.kml+xml',
};
const ordered = (places: readonly ProjectedPlace[]) =>
  [...places]
    .map((p) => ProjectedPlaceSchema.parse(p))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
const osmAttribution = (place: ProjectedPlace) =>
  ['nominatim', 'osm'].includes(place.providerIdentity.provider)
    ? '© OpenStreetMap contributors; https://www.openstreetmap.org/copyright'
    : undefined;
// Every serialized position is WGS84: RFC 7946 GeoJSON requires it, and GPX 1.1 and KML 2.2
// define their coordinates as WGS84 too. The CRS travels with the coordinate value itself
// (CoordinatesSchema `crs`), and projection has already put every point on a standard WGS84
// map (map-alignment.ts), so serializers never convert. A coordinate in any other system is
// refused here instead of being emitted with mislabelled numbers.
export function wgs84Position(coordinates: ProjectedPlace['coordinates']) {
  if (coordinates.crs !== 'WGS84')
    throw new Error('projection_non_wgs84_coordinates');
  return { latitude: coordinates.latitude, longitude: coordinates.longitude };
}
const wgs84LongitudeLatitude = (p: ProjectedPlace): [number, number] => {
  const { latitude, longitude } = wgs84Position(p.coordinates);
  return [longitude, latitude];
};
export function geojson(places: readonly ProjectedPlace[]) {
  return {
    type: 'FeatureCollection' as const,
    features: ordered(places).map((p) => ({
      type: 'Feature' as const,
      id: p.id,
      geometry: {
        type: 'Point' as const,
        coordinates: wgs84LongitudeLatitude(p),
      },
      properties: {
        label: p.label,
        tags: p.tags,
        provider: p.providerIdentity.provider,
        ...(osmAttribution(p) ? { attribution: osmAttribution(p) } : {}),
        ...(p.category !== undefined ? { category: p.category } : {}),
        ...(p.city !== undefined ? { city: p.city } : {}),
        ...(p.cityKey !== undefined ? { cityKey: p.cityKey } : {}),
        ...(p.address !== undefined ? { address: p.address } : {}),
        ...(p.sourceLink ? { sourceLink: p.sourceLink } : {}),
      },
    })),
  };
}
// Escape XML 1.0 data and omit forbidden controls/unpaired surrogates; never use CDATA.
export const xmlText = (text: string) =>
  Array.from(text)
    .filter((c) => {
      const n = c.codePointAt(0)!;
      return (
        n === 9 ||
        n === 10 ||
        n === 13 ||
        (n >= 0x20 && n <= 0xd7ff) ||
        (n >= 0xe000 && n <= 0xfffd) ||
        (n >= 0x10000 && n <= 0x10ffff)
      );
    })
    .join('')
    .replace(
      /[&<>"']/gu,
      (c) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&apos;',
        })[c]!,
    );
export function gpx(places: readonly ProjectedPlace[]) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Places" xmlns="http://www.topografix.com/GPX/1/1">' +
    ordered(places)
      .map(
        (p) =>
          `<wpt lat="${wgs84LongitudeLatitude(p)[1]}" lon="${wgs84LongitudeLatitude(p)[0]}"><name>${xmlText(p.label)}</name>${osmAttribution(p) ? `<desc>${xmlText(osmAttribution(p)!)}</desc>` : ''}</wpt>`,
      )
      .join('') +
    '</gpx>\n'
  );
}
export function kml(places: readonly ProjectedPlace[]) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document>' +
    ordered(places)
      .map(
        (p) =>
          `<Placemark id="place-${p.id}"><name>${xmlText(p.label)}</name>${osmAttribution(p) ? `<description>${xmlText(osmAttribution(p)!)}</description>` : ''}<Point><coordinates>${wgs84LongitudeLatitude(p).join(',')}</coordinates></Point></Placemark>`,
      )
      .join('') +
    '</Document></kml>\n'
  );
}
export function serializeProjection(
  format: ProjectionFormat,
  places: readonly ProjectedPlace[],
): string {
  return format === 'geojson'
    ? JSON.stringify(geojson(places)) + '\n'
    : format === 'gpx'
      ? gpx(places)
      : kml(places);
}
