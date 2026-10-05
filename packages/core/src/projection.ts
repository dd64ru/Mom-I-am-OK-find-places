import {
  CoordinatesSchema,
  ProjectedPlaceSchema,
  type ProjectedPlace,
  PlaceSchema,
  type Place,
  type PlaceDisplay,
} from '@places/schemas';
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
    input: readonly Place[],
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
    const ordered = [...input].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
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
          const raw = ordered[cursor++]!;
          const parsed = PlaceSchema.safeParse(raw);
          if (!parsed.success) {
            counts.invalidPlaces++;
            continue;
          }
          const place = parsed.data;
          if (place.status !== 'confirmed') continue;
          const google = 'providerIdentity' in place;
          const label =
            place.label ?? (!google ? place.canonicalName : undefined);
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
              const coordinates = CoordinatesSchema.parse(view.coordinates);
              output.push(
                ProjectedPlaceSchema.parse({
                  id: place.id,
                  label,
                  coordinates,
                  tags: [...place.tags],
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
                coordinates: place.coordinates,
                category: place.category,
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
export function geojson(places: readonly ProjectedPlace[]) {
  return {
    type: 'FeatureCollection' as const,
    features: ordered(places).map((p) => ({
      type: 'Feature' as const,
      id: p.id,
      geometry: {
        type: 'Point' as const,
        coordinates: [p.coordinates.longitude, p.coordinates.latitude],
      },
      properties: {
        label: p.label,
        tags: p.tags,
        provider: p.providerIdentity.provider,
        ...(osmAttribution(p) ? { attribution: osmAttribution(p) } : {}),
        ...(p.category !== undefined ? { category: p.category } : {}),
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
          `<wpt lat="${p.coordinates.latitude}" lon="${p.coordinates.longitude}"><name>${xmlText(p.label)}</name>${osmAttribution(p) ? `<desc>${xmlText(osmAttribution(p)!)}</desc>` : ''}</wpt>`,
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
          `<Placemark id="place-${p.id}"><name>${xmlText(p.label)}</name>${osmAttribution(p) ? `<description>${xmlText(osmAttribution(p)!)}</description>` : ''}<Point><coordinates>${p.coordinates.longitude},${p.coordinates.latitude}</coordinates></Point></Placemark>`,
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
