import {
  ApplicationLabelSchema,
  DiscoverySchema,
  MapMetadataSchema,
  PlaceSchema,
  mapMetadataFor,
  recognitionLabel,
  type ApplicationLabel,
  type Discovery,
  type MapMetadata,
  type Place,
  type StoredCandidate,
} from '@places/schemas';
export type LabelBackfillUpdate = ApplicationLabel & {
  placeId: string;
  discoveryIds: string[];
};
export type ConfirmedAssociation = {
  discovery: Discovery;
  // The one stored candidate this confirmation binds to the Place; undefined when the
  // association cannot be made deterministically (several entries for one identity, a
  // legacy multi-candidate confirmation, or a mismatched identity).
  candidate?: StoredCandidate;
};
const byId = (a: { id: string }, b: { id: string }) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
export function confirmedDiscoveries(discoveries: readonly Discovery[]) {
  return discoveries
    .map((d) => DiscoverySchema.parse(d))
    .filter((d) => d.status === 'confirmed');
}
// The single Place <-> confirmed Discovery association rule shared by every backfill:
// current confirmedPlaceIds or legacy confirmedPlaceId, same workspace, and a unique
// candidate whose provider identity is the Place's own.
export function confirmedAssociations(
  place: Place,
  confirmed: readonly Discovery[],
): ConfirmedAssociation[] {
  return confirmed
    .filter(
      (d) =>
        d.status === 'confirmed' &&
        d.workspaceId === place.workspaceId &&
        (d.confirmedPlaceId === place.id ||
          d.confirmedPlaceIds?.includes(place.id)),
    )
    .map((d) => {
      const matches =
        d.confirmedPlaceIds && 'providerIdentity' in place
          ? d.candidates.filter(
              (c) =>
                c.providerIdentity?.provider === 'google-places' &&
                c.providerIdentity.id === place.providerIdentity.id,
            )
          : d.candidates;
      // Multiple entries for one identity cannot safely bind a photographed clue.
      const candidate = matches.length === 1 ? matches[0] : undefined;
      const identityMatches =
        candidate &&
        (!('providerIdentity' in place) ||
          candidate.providerIdentity?.id === place.providerIdentity.id);
      return identityMatches ? { discovery: d, candidate } : { discovery: d };
    });
}
// Pure plan: only confirmed associations and independent Recognition can supply labels.
export function planPlaceLabels(
  places: readonly Place[],
  discoveries: readonly Discovery[],
) {
  const updates: LabelBackfillUpdate[] = [];
  const confirmed = confirmedDiscoveries(discoveries);
  let unresolved = 0,
    alreadyLabeled = 0;
  for (const raw of [...places].sort(byId)) {
    const place = PlaceSchema.parse(raw);
    if (place.status !== 'confirmed') continue;
    if (place.label !== undefined) {
      alreadyLabeled++;
      continue;
    }
    const derived = confirmedAssociations(place, confirmed).map(
      ({ discovery: d, candidate }) => ({
        d,
        // Related branches/chain locations never inherit the photographed venue's label.
        label:
          candidate && !candidate.relationship?.startsWith('related_')
            ? recognitionLabel(d.recognition, candidate.recognitionClueIndex)
            : undefined,
      }),
    );
    const labels = [
      ...new Set(derived.filter((d) => d.label).map((d) => d.label!.label)),
    ];
    if (labels.length !== 1) {
      unresolved++;
      continue;
    }
    updates.push({
      placeId: place.id,
      ...ApplicationLabelSchema.parse({
        label: labels[0],
        labelSource: 'recognition',
      }),
      discoveryIds: derived
        .filter((d) => d.label?.label === labels[0])
        .map((d) => d.d.id)
        .sort(),
    });
  }
  return {
    updates,
    counts: {
      placesTotal: places.length,
      planned: updates.length,
      unresolved,
      alreadyLabeled,
    },
  };
}
export type MapMetadataBackfillUpdate = {
  placeId: string;
  // Only the fields this plan adds; existing fields are never part of an update.
  add: MapMetadata;
  discoveryIds: string[];
};
// Stronger source first. A weaker source is consulted only when no stronger one exists.
const SOURCE_STRENGTH = ['user', 'recognition'] as const;
// Pure plan for missing Google Place map metadata, from already persisted confirmed
// Discoveries only (no provider call, no provider display content). Per field, the
// strongest source present must agree on exactly one value; otherwise the field stays
// unresolved. Existing values are never replaced.
export function planPlaceMapMetadata(
  places: readonly Place[],
  discoveries: readonly Discovery[],
) {
  const updates: MapMetadataBackfillUpdate[] = [];
  const confirmed = confirmedDiscoveries(discoveries);
  const counts = {
    placesTotal: places.length,
    googlePlaces: 0,
    planned: 0,
    cityPlanned: 0,
    categoryPlanned: 0,
    // Nothing independent to derive from (for example no user city and no clue areaHint).
    cityUnavailable: 0,
    categoryUnavailable: 0,
    // Conflicting or ambiguous independent derivations: skipped, never guessed.
    cityConflict: 0,
    categoryConflict: 0,
    cityPresent: 0,
    categoryPresent: 0,
  };
  for (const raw of [...places].sort(byId)) {
    const place = PlaceSchema.parse(raw);
    if (place.status !== 'confirmed' || !('providerIdentity' in place))
      continue;
    counts.googlePlaces++;
    const derived = confirmedAssociations(place, confirmed).flatMap(
      ({ discovery, candidate }) =>
        candidate
          ? [{ discovery, metadata: mapMetadataFor(discovery, candidate) }]
          : [],
    );
    const add: { city?: unknown; category?: unknown } = {};
    const sources = new Set<string>();
    for (const field of ['city', 'category'] as const) {
      if (place.mapMetadata?.[field]) {
        counts[`${field}Present`]++;
        continue;
      }
      const offered = derived.flatMap((d) => {
        const entry = d.metadata?.[field];
        return entry ? [{ id: d.discovery.id, ...entry }] : [];
      });
      const strongest = SOURCE_STRENGTH.find((source) =>
        offered.some((o) => o.source === source),
      );
      const chosen = offered.filter((o) => o.source === strongest);
      const values = [...new Set(chosen.map((o) => o.value))];
      if (values.length !== 1) {
        if (values.length) counts[`${field}Conflict`]++;
        else counts[`${field}Unavailable`]++;
        continue;
      }
      add[field] = { value: values[0], source: strongest };
      for (const o of chosen) sources.add(o.id);
      counts[`${field}Planned`]++;
    }
    if (!add.city && !add.category) continue;
    updates.push({
      placeId: place.id,
      add: MapMetadataSchema.parse(add),
      discoveryIds: [...sources].sort(),
    });
  }
  counts.planned = updates.length;
  return { updates, counts };
}
