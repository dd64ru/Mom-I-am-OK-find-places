import {
  ApplicationLabelSchema,
  DiscoverySchema,
  PlaceSchema,
  recognitionLabel,
  type ApplicationLabel,
  type Discovery,
  type Place,
} from '@places/schemas';
export type LabelBackfillUpdate = ApplicationLabel & {
  placeId: string;
  discoveryIds: string[];
};
// Pure plan: only confirmed associations and independent Recognition can supply labels.
export function planPlaceLabels(
  places: readonly Place[],
  discoveries: readonly Discovery[],
) {
  const updates: LabelBackfillUpdate[] = [];
  const confirmed = discoveries
    .map((d) => DiscoverySchema.parse(d))
    .filter((d) => d.status === 'confirmed');
  let unresolved = 0,
    alreadyLabeled = 0;
  for (const raw of [...places].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  )) {
    const place = PlaceSchema.parse(raw);
    if (place.status !== 'confirmed') continue;
    if (place.label !== undefined) {
      alreadyLabeled++;
      continue;
    }
    const associated = confirmed.filter(
      (d) =>
        d.status === 'confirmed' &&
        d.workspaceId === place.workspaceId &&
        d.confirmedPlaceId === place.id,
    );
    const derived = associated.map((d) => ({
      d,
      label:
        d.candidates.length > 1 ||
        ('providerIdentity' in place &&
          d.candidates[0]?.providerIdentity?.provider === 'google-places' &&
          d.candidates[0].providerIdentity.id !== place.providerIdentity.id)
          ? undefined
          : recognitionLabel(
              d.recognition,
              d.candidates[0]?.recognitionClueIndex,
            ),
    }));
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
