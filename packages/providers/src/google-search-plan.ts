import type {
  Recognition,
  Verification,
  GeographicContext,
} from '@places/schemas';
import { normalizedLocality, type Locality } from './locality.js';
import { nameTokens } from './place-matching.js';
export type GooglePhase =
  'google_first_pass' | 'google_enriched_pass' | 'google_related_pass';
type Clue = Recognition['clues'][number] | Verification['candidates'][number];
const name = (c: Clue) => ('canonicalName' in c ? c.canonicalName : c.name);
// Eligibility uses schema-valid clues, never an AI confidence/city threshold.
export function googleSearchPlan(
  r: Recognition,
  v: Verification,
  ctx: GeographicContext,
) {
  const cited =
    v.status === 'verified' && v.references.length ? v.candidates : [];
  const clues: Clue[] = [
    ...r.clues.filter((c) => c.signage),
    ...(cited.length ? cited : r.clues),
  ]
    .slice(0, 3)
    .sort((a, b) => b.confidence - a.confidence);
  const intent =
    ctx.cityOverride &&
    v.localityIntent?.input === ctx.cityOverride &&
    v.localityIntent.confidence >= 0.9
      ? v.localityIntent
      : undefined;
  let locality: Locality | undefined;
  if (ctx.cityOverride) {
    const aliases = [
      ctx.cityOverride,
      ...(intent ? [intent.canonicalName, ...intent.aliases] : []),
    ];
    const aligned = cited.find(
      (c) =>
        c.city &&
        [c.city, ...c.cityAliases].some((city) =>
          aliases.some(
            (a) => normalizedLocality(a) === normalizedLocality(city),
          ),
        ),
    );
    locality = {
      name: intent?.canonicalName ?? aligned?.city ?? ctx.cityOverride,
      aliases: [
        ...new Set([
          ...aliases,
          ...(aligned?.city ? [aligned.city, ...aligned.cityAliases] : []),
        ]),
      ],
      countryCode: intent?.countryCode ?? aligned?.countryCode,
      source: 'explicit',
    };
  } else if (
    cited.length &&
    cited.every(
      (c) =>
        c.city &&
        normalizedLocality(c.city) === normalizedLocality(cited[0]!.city!),
    ) &&
    new Set(cited.map((c) => c.countryCode).filter(Boolean)).size <= 1
  ) {
    const c = cited[0]!;
    locality = {
      name: c.city!,
      aliases: [...new Set(cited.flatMap((c) => [c.city!, ...c.cityAliases]))],
      countryCode: cited.find((c) => c.countryCode)?.countryCode,
      source: 'verified',
    };
  }
  if (!locality && cited.length) {
    const countries = [
      ...new Set(
        cited.map((c) => c.countryCode).filter((c): c is string => !!c),
      ),
    ];
    if (countries.length === 1)
      locality = {
        name: '',
        aliases: [],
        countryCode: countries[0],
        source: 'verified',
      };
  }
  const primary = clues[0];
  if (!primary) return { clues, locality, queries: [] as string[] };
  const variants: { clue: Clue; text: string }[] = [
    ...r.clues
      .filter((c) => c.signage)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 1)
      .map((c) => ({ clue: c, text: c.signage! })),
    ...clues.map((c) => ({ clue: c, text: c.nativeName || name(c) })),
    ...clues.flatMap((c) =>
      [
        name(c),
        ...c.aliases.slice(0, 2),
        nameTokens(name(c)).reverse().join(' '),
        [...nameTokens(name(c))].sort((a, b) => b.length - a.length)[0],
      ]
        .filter((s): s is string => !!s)
        .map((text) => ({ clue: c, text })),
    ),
  ];
  const queries = [
    ...new Set(
      variants.map(({ clue, text }) =>
        [
          text.slice(0, 300),
          locality?.name ??
            ('canonicalName' in clue
              ? clue.city
              : clue.areaHint?.slice(0, 200)) ??
            ctx.workspaceAreaHint,
          'addressClue' in clue ? clue.addressClue : undefined,
          locality?.countryCode,
        ]
          .filter(Boolean)
          .join(', ')
          .slice(0, 800),
      ),
    ),
  ].slice(0, 2);
  return { clues, locality, queries };
}
