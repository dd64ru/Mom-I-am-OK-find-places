import { Firestore } from '@google-cloud/firestore';
import { pathToFileURL } from 'node:url';
import { planPlaceMapMetadata } from '@places/core';
import {
  DiscoverySchema,
  IdSchema,
  MapMetadataSchema,
  PlaceSchema,
} from '@places/schemas';
import {
  backfillArguments,
  placeFingerprint,
  scanConfirmedScope,
} from './backfill-place-labels.mjs';
// Owner-only backfill of missing application-owned Google Place map metadata
// (mapMetadata.city / mapMetadata.category) from already persisted confirmed Discoveries.
// Plan by default; --apply is required for writes. No Google request, no provider display
// content, aggregate-only output.
export async function backfillPlaceMapMetadata(db, workspace, mode = 'plan') {
  IdSchema.parse(workspace);
  if (!['plan', 'apply'].includes(mode))
    throw new Error('backfill_mode_invalid');
  const { root, places, discoveries } = await scanConfirmedScope(db, workspace);
  const plan = planPlaceMapMetadata(places, discoveries);
  let applied = 0,
    stale = 0;
  if (mode === 'apply') {
    for (const update of plan.updates) {
      const original = places.find((place) => place.id === update.placeId);
      if (update.discoveryIds.length > 20) {
        stale++;
        continue;
      }
      const changed = await db.runTransaction(async (tx) => {
        const placeRef = root.collection('places').doc(update.placeId);
        const snapshot = await tx.get(placeRef);
        if (!snapshot.exists) return false;
        const current = PlaceSchema.parse(snapshot.data());
        if (
          current.workspaceId !== workspace ||
          current.id !== update.placeId ||
          placeFingerprint(current) !== placeFingerprint(original)
        )
          return false;
        const sources = [];
        for (const id of update.discoveryIds) {
          const row = await tx.get(root.collection('discoveries').doc(id));
          if (!row.exists) return false;
          const discovery = DiscoverySchema.parse(row.data());
          if (discovery.workspaceId !== workspace || discovery.id !== id)
            return false;
          sources.push(discovery);
        }
        // Re-derive inside the transaction from the re-read Place and Discoveries only.
        const checked = planPlaceMapMetadata([current], sources).updates[0];
        if (
          !checked ||
          JSON.stringify(checked.add) !== JSON.stringify(update.add)
        )
          return false;
        // Existing fields win: the planned additions only fill absent fields.
        const mapMetadata = MapMetadataSchema.parse({
          ...update.add,
          ...(current.mapMetadata ?? {}),
        });
        tx.update(placeRef, {
          mapMetadata,
          updatedAt: new Date().toISOString(),
        });
        return true;
      });
      if (changed) applied++;
      else stale++;
    }
  }
  // Only aggregates leave the utility; never print cities, categories, labels, IDs or paths.
  return {
    event: 'place_map_metadata_backfill',
    mode,
    ...plan.counts,
    applied,
    stale,
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const options = backfillArguments(process.argv.slice(2));
    const result = await backfillPlaceMapMetadata(
      new Firestore({ projectId: options.project }),
      options.workspace,
      options.mode,
    );
    console.log(JSON.stringify(result));
  } catch {
    console.error('place_map_metadata_backfill_failed');
    process.exitCode = 1;
  }
}
