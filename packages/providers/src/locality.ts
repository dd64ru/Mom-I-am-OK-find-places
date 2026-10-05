import type {
  Recognition,
  Verification,
  GeographicContext,
  PoiResolution,
} from '@places/schemas';
export const normalizedName = (value: string) =>
  value.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ');
export const normalizedLocality = (value: string) =>
  normalizedName(value).replace(/^([\p{Script=Han}]+)市$/u, '$1');
export interface Locality {
  name: string;
  aliases: string[];
  countryCode?: string;
  source: 'explicit' | 'verified' | 'vision';
}
type Clue = Recognition['clues'][number] | Verification['candidates'][number];
type Decision =
  | { status: 'ready'; clue: Clue; locality: Locality }
  | Exclude<PoiResolution, { status: 'resolved' }>;
const names = (clue: Verification['candidates'][number]) =>
  [clue.city, ...clue.cityAliases].filter((s): s is string => !!s);
const matches = (value: string, aliases: string[]) =>
  aliases.some((a) => normalizedLocality(a) === normalizedLocality(value));
export function selectLocality(
  recognition: Recognition,
  verification: Verification,
  context: GeographicContext,
  allowMultiple = false,
): Decision {
  if (!recognition.clues.length)
    return { status: 'unresolved', reason: 'no_place_evidence' };
  const intent =
    context.cityOverride &&
    verification.localityIntent?.input === context.cityOverride &&
    verification.localityIntent.confidence >= 0.9
      ? verification.localityIntent
      : undefined;
  const overrideAliases = intent
    ? [intent.canonicalName, ...intent.aliases, context.cityOverride!]
    : context.cityOverride
      ? [context.cityOverride]
      : [];
  const intentMatches = (aliases: string[]) =>
    overrideAliases.some((a) => matches(a, aliases));
  let verified =
    verification.status === 'verified' && verification.references.length
      ? verification.candidates.filter((c) => c.confidence >= 0.8)
      : [];
  if (context.cityOverride && verified.length) {
    const matching = verified.filter(
      (c) =>
        c.city &&
        intentMatches(names(c)) &&
        (!intent?.countryCode ||
          !c.countryCode ||
          intent.countryCode === c.countryCode),
    );
    if (matching.length) verified = matching;
    else if (verified.some((c) => c.city))
      return { status: 'unresolved', reason: 'locality_conflict' };
  }
  if (verified.length > 1) {
    if (!allowMultiple && context.cityOverride)
      return { status: 'unresolved', reason: 'insufficient_evidence' };
    if (
      context.cityOverride &&
      !verified.every((c) => c.city && intentMatches(names(c)))
    )
      return { status: 'unresolved', reason: 'insufficient_evidence' };
    const localities = new Set(
      verified.map((c) =>
        c.city ? `${normalizedLocality(c.city)}:${c.countryCode ?? ''}` : '',
      ),
    );
    if (!allowMultiple && localities.size === 1 && !localities.has(''))
      return { status: 'unresolved', reason: 'insufficient_evidence' };
    if (localities.size > 1 || localities.has(''))
      return { status: 'city_unknown', reason: 'ambiguous_locality' };
  }
  const vision = recognition.clues.filter((c) => c.confidence >= 0.85);
  const clue =
    verified[0] ??
    (vision.length === 1 || allowMultiple ? vision[0] : undefined);
  if (!clue) return { status: 'unresolved', reason: 'insufficient_evidence' };
  const geographic = verified[0];
  if (context.cityOverride)
    return {
      status: 'ready',
      clue,
      locality: {
        // A cited canonical locality can translate the user's spelling, not substitute another city.
        name: intent?.canonicalName ?? geographic?.city ?? context.cityOverride,
        aliases: [
          ...new Set([
            ...overrideAliases,
            ...(geographic?.city ? names(geographic) : []),
          ]),
        ],
        countryCode: intent?.countryCode ?? geographic?.countryCode,
        source: 'explicit',
      },
    };
  if (geographic?.city)
    return {
      status: 'ready',
      clue,
      locality: {
        name: geographic.city,
        aliases: names(geographic),
        countryCode: geographic.countryCode,
        source: 'verified',
      },
    };
  const visionArea =
    vision.length && new Set(vision.map((c) => c.areaHint?.trim())).size === 1
      ? vision[0]?.areaHint?.trim()
      : undefined;
  if (visionArea)
    return {
      status: 'ready',
      clue,
      locality: {
        name: visionArea,
        aliases: [visionArea],
        countryCode: intent?.countryCode ?? geographic?.countryCode,
        source: 'vision',
      },
    };
  // A workspace hint alone cannot identify which branch was photographed. It only informs search.
  return { status: 'city_unknown', reason: 'missing_locality' };
}
export function localityMatches(
  address: Record<string, string | undefined>,
  locality: Locality,
): boolean {
  if (
    locality.countryCode &&
    address.country_code?.toUpperCase() !== locality.countryCode
  )
    return false;
  const cityFields = [address.city, address.municipality].filter(
    (s): s is string => !!s,
  );
  if (!cityFields.length)
    cityFields.push(
      ...[address.town, address.village].filter((s): s is string => !!s),
    );
  // China's province-level municipalities can be represented as state in Nominatim address output.
  if (
    !cityFields.length &&
    address.country_code === 'cn' &&
    ['CN-BJ', 'CN-SH', 'CN-TJ', 'CN-CQ'].includes(
      address['ISO3166-2-lvl4'] ?? '',
    ) &&
    address.state
  )
    cityFields.push(address.state);
  // Rural results may have only a county; never let a broad county mask a conflicting named city.
  if (!cityFields.length && address.county) cityFields.push(address.county);
  return cityFields.some((value) => matches(value, locality.aliases));
}
