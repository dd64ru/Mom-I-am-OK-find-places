// Small deterministic scores, never unrestricted fuzzy/entity matching.
const generic = new Set([
  'ресторан',
  'кафе',
  'университет',
  'магазин',
  '大学',
  '餐厅',
  '咖啡店',
  '酒店',
  '商店',
  'restaurant',
  'cafe',
  'café',
  'coffee',
  'hotel',
  'store',
  'shop',
  'university',
  'college',
  'building',
  'landmark',
  'the',
  'of',
  'and',
  'grand',
  'grande',
  'historic',
]);
export const nameTokens = (s: string) =>
  s
    .slice(0, 300)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];
const distinct = (s: string) => nameTokens(s).filter((t) => !generic.has(t));
function oneEdit(a: string, b: string) {
  if (
    a.length < 7 ||
    b.length < 7 ||
    a.length > 64 ||
    b.length > 64 ||
    Math.abs(a.length - b.length) > 1 ||
    !/^[a-z]+$/.test(a + b)
  )
    return false;
  let i = 0,
    j = 0,
    edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length <= b.length) j++;
    if (a.length >= b.length) i++;
  }
  return edits + (i < a.length || j < b.length ? 1 : 0) <= 1;
}
export function venueNameScore(evidence: string, returned: string): number {
  const a = nameTokens(evidence),
    b = nameTokens(returned);
  if (
    !a.length ||
    !b.length ||
    a.length > 12 ||
    b.length > 12 ||
    !(
      distinct(evidence).some(
        (t) => t.length >= 4 || /\p{Script=Han}/u.test(t),
      ) ||
      (distinct(evidence).length >= 2 &&
        distinct(evidence).join('').length >= 7)
    )
  )
    return 0;
  if (a.join('') === b.join('')) return 0.96;
  if ([...a].sort().join('|') === [...b].sort().join('|')) return 0.94;
  const left = distinct(evidence),
    right = distinct(returned);
  // Retain extra distinctive branch words; generic words cannot authorize a match alone.
  const used = new Set<number>();
  let typo = false;
  for (const token of left) {
    const index = right.findIndex(
      (t, i) => !used.has(i) && (t === token || oneEdit(t, token)),
    );
    if (index < 0) return 0;
    if (right[index] !== token) typo = true;
    used.add(index);
  }
  if (!left.length) return 0;
  if (left.length === right.length && a.length === b.length)
    return typo ? 0.86 : 0.9;
  if (
    typo ||
    left.length > right.length ||
    right.length - left.length > 1 ||
    !left.some((t) => t.length >= 7)
  )
    return 0;
  // A distinctive partial sign requires additional locality/country/category support.
  return 0.72;
}
const categoryGroups: [RegExp, (t: string) => boolean][] = [
  [
    /cafe|coffee|bakery|restaurant|dining|food|bar|pub/,
    (t) =>
      [
        'cafe',
        'coffee_shop',
        'bakery',
        'restaurant',
        'food_court',
        'bar',
        'pub',
      ].includes(t) || t.endsWith('_restaurant'),
  ],
  [
    /university|college|school/,
    (t) =>
      ['university', 'school', 'college', 'educational_institution'].includes(
        t,
      ),
  ],
  [
    /shop|store|retail|market/,
    (t) =>
      ['store', 'market', 'supermarket', 'shopping_mall'].includes(t) ||
      t.endsWith('_store'),
  ],
  [/museum/, (t) => t === 'museum' || t.endsWith('_museum')],
  [
    /park|garden/,
    (t) => ['park', 'garden', 'national_park', 'botanical_garden'].includes(t),
  ],
  [
    /station|airport|transport/,
    (t) =>
      ['train_station', 'bus_station', 'transit_station', 'airport'].includes(
        t,
      ),
  ],
  [/street|address|route/, (t) => ['street_address', 'route'].includes(t)],
];
export function recognizedCategory(types: string[]) {
  return types.find((t) => categoryGroups.some(([, match]) => match(t)));
}
export function categorySupport(
  category: string,
  types: string[],
): 'compatible' | 'related' | 'unknown' | 'conflict' {
  const c = category.toLowerCase();
  const expected = categoryGroups.findIndex(([pattern]) => pattern.test(c));
  if (types.includes(c)) return 'compatible';
  if (expected < 0) return 'unknown';
  if (types.some(categoryGroups[expected]![1])) return 'related';
  // Unknown/evolving types are neutral. Only known unrelated domains incur a penalty.
  return types.some((t) => categoryGroups.some(([, match]) => match(t)))
    ? 'conflict'
    : 'unknown';
}
export const categoryWeight = (support: ReturnType<typeof categorySupport>) =>
  support === 'compatible'
    ? 0.05
    : support === 'related'
      ? 0.03
      : support === 'conflict'
        ? -0.3
        : 0;
export const GOOGLE_MATCH_THRESHOLD = 0.88,
  GOOGLE_MATCH_MARGIN = 0.12;
