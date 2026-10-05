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
export function categorySupport(
  category: string,
  types: string[],
): 'compatible' | 'unknown' | 'conflict' {
  const c = category.toLowerCase();
  const groups: [RegExp, (t: string) => boolean][] = [
    [
      /cafe|coffee|bakery/,
      (t) => ['cafe', 'coffee_shop', 'bakery'].includes(t),
    ],
    [
      /restaurant|dining|food/,
      (t) =>
        t === 'restaurant' || t.endsWith('_restaurant') || t === 'food_court',
    ],
    [/university|college/, (t) => t === 'university'],
    [
      /shop|store|retail|market/,
      (t) =>
        t === 'store' ||
        t.endsWith('_store') ||
        ['market', 'supermarket', 'shopping_mall'].includes(t),
    ],
    [/museum/, (t) => t === 'museum'],
    [
      /park|garden/,
      (t) =>
        ['park', 'national_park', 'garden', 'botanical_garden'].includes(t),
    ],
  ];
  const group = groups.find(([pattern]) => pattern.test(c));
  return group
    ? types.some(group[1])
      ? 'compatible'
      : 'conflict'
    : types.includes(c)
      ? 'compatible'
      : 'unknown';
}
export const GOOGLE_MATCH_THRESHOLD = 0.88,
  GOOGLE_MATCH_MARGIN = 0.12;
