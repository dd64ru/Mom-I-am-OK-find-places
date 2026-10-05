import { Firestore, FieldPath } from '@google-cloud/firestore';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { planPlaceLabels } from '@places/core';
import { DiscoverySchema, IdSchema, PlaceSchema } from '@places/schemas';
const fingerprint = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function backfillPlaceLabels(db, workspace, mode = 'plan') {
  IdSchema.parse(workspace);
  if (!['plan', 'apply'].includes(mode))
    throw new Error('backfill_mode_invalid');
  const root = db.collection('workspaces').doc(workspace);
  const [placeRows, discoveryRows] = await Promise.all([
    root
      .collection('places')
      .where('status', '==', 'confirmed')
      .orderBy(FieldPath.documentId())
      .limit(1001)
      .get(),
    root
      .collection('discoveries')
      .where('status', '==', 'confirmed')
      .orderBy(FieldPath.documentId())
      .limit(5001)
      .get(),
  ]);
  if (placeRows.size > 1000 || discoveryRows.size > 5000)
    throw new Error('backfill_scan_limit_exceeded');
  const parseScoped = (rows, schema) =>
    rows.docs.map((doc) => {
      const value = schema.parse(doc.data());
      if (value.workspaceId !== workspace || value.id !== doc.id)
        throw new Error('backfill_scope_invalid');
      return value;
    });
  const places = parseScoped(placeRows, PlaceSchema),
    discoveries = parseScoped(discoveryRows, DiscoverySchema);
  const plan = planPlaceLabels(places, discoveries);
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
          fingerprint(current) !== fingerprint(original)
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
        const checked = planPlaceLabels([current], sources).updates[0];
        if (!checked || checked.label !== update.label) return false;
        // No provider calls or content rewrites. Existing user/recognition labels never overwrite.
        tx.update(placeRef, {
          label: update.label,
          labelSource: 'recognition',
          updatedAt: new Date().toISOString(),
        });
        return true;
      });
      if (changed) applied++;
      else stale++;
    }
  }
  // Only aggregates leave the utility; never print labels, IDs, paths or user data.
  return {
    event: 'place_label_backfill',
    mode,
    ...plan.counts,
    applied,
    stale,
  };
}
export function backfillArguments(args) {
  const { values } = parseArgs({
    args,
    options: {
      plan: { type: 'boolean' },
      apply: { type: 'boolean' },
      project: { type: 'string' },
      workspace: { type: 'string' },
    },
    allowPositionals: false,
  });
  if (values.plan && values.apply) throw new Error('backfill_mode_invalid');
  if (
    !values.project ||
    !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/u.test(values.project)
  )
    throw new Error('backfill_project_required');
  return {
    project: values.project,
    workspace: IdSchema.parse(values.workspace),
    mode: values.apply ? 'apply' : 'plan',
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const options = backfillArguments(process.argv.slice(2));
    const result = await backfillPlaceLabels(
      new Firestore({ projectId: options.project }),
      options.workspace,
      options.mode,
    );
    console.log(JSON.stringify(result));
  } catch {
    console.error('place_label_backfill_failed');
    process.exitCode = 1;
  }
}
