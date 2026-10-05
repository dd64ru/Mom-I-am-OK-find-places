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
export const nameTokens = (s: string): string[] =>
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
export type NameEvidence =
  | 'exact'
  | 'reordered'
  | 'distinctive_equivalent'
  | 'strong_partial'
  | 'bounded_typo'
  | 'weak'
  | 'none';
export type NameMatch = { nameEvidence: NameEvidence; nameRank: number };
export const identityStrength = (e: NameEvidence): number =>
  ['exact', 'reordered', 'distinctive_equivalent'].includes(e)
    ? 3
    : ['strong_partial', 'bounded_typo'].includes(e)
      ? 2
      : e === 'weak'
        ? 1
        : 0;
export function venueNameEvidence(
  evidence: string,
  returned: string,
): NameMatch {
  const a = nameTokens(evidence),
    b = nameTokens(returned);
  const left = distinct(evidence),
    right = distinct(returned);
  const result = (nameEvidence: NameEvidence, nameRank: number): NameMatch => ({
    nameEvidence,
    nameRank,
  });
  if (!a.length || !b.length || a.length > 12 || b.length > 12)
    return result('none', 0);
  const meaningful =
    left.some((t) => t.length >= 4 || /\p{Script=Han}/u.test(t)) ||
    (left.length >= 2 && left.join('').length >= 7);
  if (!meaningful)
    return result(a.some((t) => b.includes(t)) ? 'weak' : 'none', 0);
  if (a.join('') === b.join('')) return result('exact', 0.96);
  const sameTokens = (x: string[], y: string[]) =>
    [...x].sort().join('|') === [...y].sort().join('|');
  if (sameTokens(a, b)) return result('reordered', 0.94);
  // Generic descriptors never penalize otherwise identical distinctive identity.
  if (sameTokens(left, right)) return result('distinctive_equivalent', 0.9);
  const used = new Set<number>();
  let typo = false;
  for (const token of left) {
    const index = right.findIndex(
      (t, i) => !used.has(i) && (t === token || oneEdit(t, token)),
    );
    if (index < 0)
      return result(left.some((t) => right.includes(t)) ? 'weak' : 'none', 0.1);
    if (right[index] !== token) typo = true;
    used.add(index);
  }
  if (left.length === right.length && typo) return result('bounded_typo', 0.86);
  if (
    !typo &&
    right.length - left.length === 1 &&
    left.some((t) => t.length >= 7)
  )
    return result('strong_partial', 0.72);
  return result('weak', 0.1);
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
        'deli',
        'food_store',
        'grocery_store',
        'supermarket',
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
      [
        'store',
        'market',
        'grocery_store',
        'supermarket',
        'shopping_mall',
      ].includes(t) || t.endsWith('_store'),
  ],
  [/museum/, (t) => t === 'museum' || t.endsWith('_museum')],
  [
    /park|garden|landmark|attraction/,
    (t) =>
      [
        'park',
        'garden',
        'national_park',
        'botanical_garden',
        'tourist_attraction',
      ].includes(t),
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
// Secondary rank separation, never an absolute acceptance cutoff.
export const GOOGLE_MATCH_MARGIN = 0.12;
