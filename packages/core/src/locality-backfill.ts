import {
  PlaceSchema,
  LocalityIdentitySchema,
  type LocalityIdentity,
} from '@places/schemas';
// PLAN ONLY. The function has no write port. Operator review/application is a
// separate future task, fenced by the original Place updatedAt.
export async function planLocalityBackfill(
  input: readonly unknown[],
  resolver: {
    resolveLocality(
      identity: { provider: string; id: string },
      city: string,
    ): Promise<LocalityIdentity | undefined>;
  },
) {
  if (input.length > 100) throw new Error('backfill_limit_exceeded');
  const plan = [];
  const counts = { normalized: 0, unavailable: 0, existing: 0, invalid: 0 };
  for (const raw of input) {
    const parsed = PlaceSchema.safeParse(raw);
    if (!parsed.success) {
      counts.invalid++;
      continue;
    }
    const place = parsed.data;
    if (
      !('providerIdentity' in place) ||
      !place.mapMetadata?.city ||
      place.status !== 'confirmed'
    ) {
      counts.unavailable++;
      continue;
    }
    if (place.mapMetadata.locality) {
      counts.existing++;
      continue;
    }
    let identity;
    try {
      identity = LocalityIdentitySchema.safeParse(
        await resolver.resolveLocality(
          place.providerIdentity,
          place.mapMetadata.city.value,
        ),
      );
    } catch {
      counts.unavailable++;
      continue;
    }
    if (!identity.success) {
      counts.unavailable++;
      continue;
    }
    plan.push({
      placeId: place.id,
      workspaceId: place.workspaceId,
      expectedUpdatedAt: place.updatedAt,
      locality: identity.data,
    });
    counts.normalized++;
  }
  plan.sort((a, b) =>
    a.placeId < b.placeId ? -1 : a.placeId > b.placeId ? 1 : 0,
  );
  return { mode: 'plan-only' as const, plan, counts };
}
