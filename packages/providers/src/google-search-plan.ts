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
  const scene = r.mode === 'scene_viewpoint';
  const safeCited = scene
    ? cited.filter(
        (c) =>
          !r.scene?.landmarks.some(
            (n) =>
              normalizedLocality(n) === normalizedLocality(c.canonicalName),
          ),
      )
    : cited;
  const clues: Clue[] = [
    ...r.clues.filter((c) => c.signage),
    ...(safeCited.length ? safeCited : r.clues),
  ]
    .slice(0, 3)
    .sort((a, b) => b.confidence - a.confidence);
  // The user's city is explicit; a recommendation list's inferred Recognition city is
  // weaker (vision) evidence. areaHint never reaches this branch.
  const requested = ctx.cityOverride ?? ctx.inferredCity ?? r.scene?.cityHint;
  const intent =
    requested &&
    v.localityIntent?.input === requested &&
    v.localityIntent.confidence >= 0.9
      ? v.localityIntent
      : undefined;
  let locality: Locality | undefined;
  if (requested) {
    const aliases = [
      requested,
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
      name: intent?.canonicalName ?? aligned?.city ?? requested,
      aliases: [
        ...new Set([
          ...aliases,
          ...(aligned?.city ? [aligned.city, ...aligned.cityAliases] : []),
        ]),
      ],
      countryCode:
        r.scene?.countryCode ?? intent?.countryCode ?? aligned?.countryCode,
      source: ctx.cityOverride ? 'explicit' : 'vision',
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
  if (r.mode === 'recommendation_list') {
    const indices = ctx.selectedBrandIndices ?? [];
    return {
      clues: indices.flatMap((i) => (r.clues[i] ? [r.clues[i]!] : [])),
      locality,
      queries: indices.flatMap((i) => {
        const c = r.clues[i];
        return c
          ? [
              [c.nativeName || c.name, locality?.name, locality?.countryCode]
                .filter(Boolean)
                .join(', ')
                .slice(0, 800),
            ]
          : [];
      }),
      unscopedQueryPlanned: false,
    };
  }
  const primary = clues[0];
  if (!primary)
    return {
      clues,
      locality,
      queries: [] as string[],
      unscopedQueryPlanned: false,
    };
  const variants: { clue: Clue; text: string; unscoped?: boolean }[] = [
    ...r.clues
      .filter((c) => c.signage)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 1)
      .map((c) => ({ clue: c, text: c.signage! })),
    // Spend the existing second slot on a different supported identity of the
    // primary venue before another competing clue or token permutation. These
    // remain search hypotheses: provider name/geography checks still decide.
    ...[primary.nativeName, name(primary), ...primary.aliases.slice(0, 1)]
      .filter((text): text is string => !!text)
      .map((text) => ({ clue: primary, text })),
    ...clues.slice(1).map((c) => ({ clue: c, text: c.nativeName || name(c) })),
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
  const first = variants[0];
  if (
    first &&
    !ctx.cityOverride &&
    !locality?.name &&
    (('areaHint' in first.clue && first.clue.areaHint) || ctx.workspaceAreaHint)
  ) {
    // Reserve an existing slot for the full primary identity without weak area
    // hints. A travel photo can be outside the workspace/model area guess.
    variants.splice(1, 0, { ...first, unscoped: true });
  }
  const planned = new Map<string, boolean>();
  for (const { clue, text, unscoped } of variants) {
    const area = unscoped
      ? undefined
      : (locality?.name ??
        ('canonicalName' in clue ? clue.city : clue.areaHint?.slice(0, 200)) ??
        ctx.workspaceAreaHint);
    const query = [
      text.slice(0, 300),
      area,
      'addressClue' in clue ? clue.addressClue : undefined,
      locality?.countryCode,
    ]
      .filter(Boolean)
      .join(', ')
      .slice(0, 800);
    if (!planned.has(query)) planned.set(query, !area);
  }
  const selected = [...planned.entries()].slice(0, 2);
  return {
    clues,
    locality,
    queries: selected.map(([query]) => query),
    unscopedQueryPlanned: selected.some(([, unscoped]) => unscoped),
  };
}
