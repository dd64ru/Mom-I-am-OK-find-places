// Map-data alignment of an acquired coordinate, kept apart from its reference system.
//
// Google documents Places API locations as WGS84, and projection keeps that `crs`. What differs
// is the map data the numbers are aligned to: inside mainland China, Google's map data (and so
// every coordinate taken from it) is offset by the GCJ-02 obfuscation, so a Google point there
// lands a few hundred metres away on a WGS84 map such as OpenStreetMap or Organic Maps.
//
//   standard-wgs84   aligned to a normal WGS84 map; emitted unchanged
//                    (stored OSM/Nominatim coordinates)
//   google-mainland  acquired from Google map data; inside mainland China it is corrected by
//                    GCJ-02 -> WGS84, everywhere else (Hong Kong, Macao and Taiwan included)
//                    it is unchanged (the Places API refresh in projection)
//
// The alignment is transient: it is decided by the acquisition path inside projection, applied
// exactly once there, and never serialized. GeoJSON, GPX and KML receive final WGS84 only.

import {
  MAINLAND_CHINA_REGION,
  MAINLAND_CHINA_REGION_SCALE,
} from './mainland-china-region.generated.js';

export type CoordinateAlignment = 'standard-wgs84' | 'google-mainland';
export type LatLng = Readonly<{ latitude: number; longitude: number }>;

// GCJ-02 <-> WGS84: the published forward formula (Krasovsky 1940 constants) and its inverse
// by fixed-point iteration until the round trip is below 1e-10 degrees. The same arithmetic
// as Mom-I-am-OK src/lib/maps/gcj02.ts.
const A = 6378245.0;
const EE = 0.00669342162296594323;
const MAX_ITERATIONS = 30;
const TOLERANCE_DEG = 1e-10;

function assertValid({ latitude, longitude }: LatLng): void {
  if (
    typeof latitude !== 'number' ||
    typeof longitude !== 'number' ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  )
    throw new RangeError('A finite latitude/longitude in range is required.');
}

function transformLat(x: number, y: number): number {
  let ret =
    -100.0 +
    2.0 * x +
    3.0 * y +
    0.2 * y * y +
    0.1 * x * y +
    0.2 * Math.sqrt(Math.abs(x));
  ret +=
    ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) *
      2.0) /
    3.0;
  ret +=
    ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) *
      2.0) /
    3.0;
  ret +=
    ((160.0 * Math.sin((y / 12.0) * Math.PI) +
      320 * Math.sin((y * Math.PI) / 30.0)) *
      2.0) /
    3.0;
  return ret;
}

function transformLng(x: number, y: number): number {
  let ret =
    300.0 +
    x +
    2.0 * y +
    0.1 * x * x +
    0.1 * x * y +
    0.1 * Math.sqrt(Math.abs(x));
  ret +=
    ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) *
      2.0) /
    3.0;
  ret +=
    ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) *
      2.0) /
    3.0;
  ret +=
    ((150.0 * Math.sin((x / 12.0) * Math.PI) +
      300.0 * Math.sin((x / 30.0) * Math.PI)) *
      2.0) /
    3.0;
  return ret;
}

function forward(latitude: number, longitude: number) {
  const radLat = (latitude / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  const dLat =
    (transformLat(longitude - 105.0, latitude - 35.0) * 180.0) /
    (((A * (1 - EE)) / (magic * sqrtMagic)) * Math.PI);
  const dLng =
    (transformLng(longitude - 105.0, latitude - 35.0) * 180.0) /
    ((A / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return { latitude: latitude + dLat, longitude: longitude + dLng };
}

export function wgs84ToGcj02(point: LatLng): LatLng {
  assertValid(point);
  return forward(point.latitude, point.longitude);
}

export function gcj02ToWgs84(point: LatLng): LatLng {
  assertValid(point);
  let latitude = point.latitude;
  let longitude = point.longitude;
  for (let i = 0; i < MAX_ITERATIONS; i += 1) {
    const image = forward(latitude, longitude);
    const dLat = image.latitude - point.latitude;
    const dLng = image.longitude - point.longitude;
    latitude -= dLat;
    longitude -= dLng;
    if (Math.abs(dLat) < TOLERANCE_DEG && Math.abs(dLng) < TOLERANCE_DEG) break;
  }
  return { latitude, longitude };
}

// Offline mainland-China predicate over the Natural Earth region (Hong Kong, Macao and Taiwan,
// with Kinmen and Matsu, are separate countries there and so outside). The region is a closed
// set: a point exactly on a ring is inside the polygon whose ring it lies on; elsewhere the
// even-odd rule decides. The same rule as Mom-I-am-OK src/lib/maps/mainlandChina.ts.
type Ring = Readonly<{ xs: Float64Array; ys: Float64Array }>;
type Polygon = Readonly<{
  rings: readonly Ring[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}>;
let decoded: readonly Polygon[] | null = null;

function decodeRing(flat: readonly number[]): Ring {
  const count = flat.length / 2;
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  let x = 0;
  let y = 0;
  for (let i = 0; i < count; i += 1) {
    x += flat[2 * i]!;
    y += flat[2 * i + 1]!;
    xs[i] = x;
    ys[i] = y;
  }
  return { xs, ys };
}

function polygons(): readonly Polygon[] {
  if (decoded) return decoded;
  decoded = MAINLAND_CHINA_REGION.map((rings) => {
    const decodedRings = rings.map(decodeRing);
    const outer = decodedRings[0]!;
    return {
      rings: decodedRings,
      minX: Math.min(...outer.xs),
      minY: Math.min(...outer.ys),
      maxX: Math.max(...outer.xs),
      maxY: Math.max(...outer.ys),
    };
  });
  return decoded;
}

function onSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): boolean {
  if ((bx - ax) * (py - ay) - (by - ay) * (px - ax) !== 0) return false;
  return (
    px >= Math.min(ax, bx) &&
    px <= Math.max(ax, bx) &&
    py >= Math.min(ay, by) &&
    py <= Math.max(ay, by)
  );
}

function ringPosition(
  ring: Ring,
  px: number,
  py: number,
): 'boundary' | boolean {
  const { xs, ys } = ring;
  let inside = false;
  for (let i = 0, j = xs.length - 1; i < xs.length; j = i, i += 1) {
    const xi = xs[i]!;
    const yi = ys[i]!;
    const xj = xs[j]!;
    const yj = ys[j]!;
    if (onSegment(px, py, xj, yj, xi, yi)) return 'boundary';
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

export function isInMainlandChina(
  latitude: number,
  longitude: number,
): boolean {
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  )
    return false;
  const px = longitude * MAINLAND_CHINA_REGION_SCALE;
  const py = latitude * MAINLAND_CHINA_REGION_SCALE;
  for (const polygon of polygons()) {
    if (
      px < polygon.minX ||
      px > polygon.maxX ||
      py < polygon.minY ||
      py > polygon.maxY
    )
      continue;
    const outer = ringPosition(polygon.rings[0]!, px, py);
    if (outer === 'boundary') return true;
    if (!outer) continue;
    let inHole = false;
    for (let h = 1; h < polygon.rings.length; h += 1) {
      const hole = ringPosition(polygon.rings[h]!, px, py);
      if (hole === 'boundary') return true;
      if (hole) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

/** The position on a standard WGS84 map for a coordinate of the given map-data alignment. */
export function standardWgs84Position(
  point: LatLng,
  alignment: CoordinateAlignment,
): LatLng {
  assertValid(point);
  if (
    alignment === 'google-mainland' &&
    isInMainlandChina(point.latitude, point.longitude)
  )
    return gcj02ToWgs84(point);
  return { latitude: point.latitude, longitude: point.longitude };
}
