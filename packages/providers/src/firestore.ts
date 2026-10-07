import { createHash } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import {
  IdSchema,
  fillMissingMapMetadata,
  mapMetadataFor,
  recognitionLabel,
  NewSavedLabelSchema,
  SelectedLabelSchema,
  WorkspaceSchema,
  PlaceSchema,
  ChainSchema,
  DiscoverySchema,
  type MapMetadata,
  type Place,
  type Chain,
  type Discovery,
  type Workspace,
  type Candidate,
  type StoredCandidate,
} from '@places/schemas';
import type { PlacesRepository } from '@places/core';
// Admin SDK uses ADC; security rules do not restrict this trusted runtime.
export class FirestoreRepository implements PlacesRepository {
  constructor(private readonly db: Firestore) {}
  private workspace(id: string) {
    return this.db.collection('workspaces').doc(IdSchema.parse(id));
  }
  private doc(workspaceId: string, collection: string, id: string) {
    return this.workspace(workspaceId)
      .collection(collection)
      .doc(IdSchema.parse(id));
  }
  async getWorkspace(id: string) {
    const snapshot = await this.workspace(id).get();
    return snapshot.exists ? WorkspaceSchema.parse(snapshot.data()) : undefined;
  }
  async initWorkspace(value: Workspace) {
    const workspace = WorkspaceSchema.parse(value);
    const ref = this.workspace(workspace.id);
    return this.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (snapshot.exists) {
        const parsed = WorkspaceSchema.safeParse(snapshot.data());
        if (
          !parsed.success ||
          parsed.data.id !== workspace.id ||
          parsed.data.members.length !== 0 ||
          parsed.data.settings.locale !== workspace.settings.locale
        )
          throw new Error('workspace_initialization_conflict');
        return parsed.data;
      }
      tx.create(ref, clean(workspace));
      return workspace;
    });
  }
  async reviseDiscovery(
    workspaceId: string,
    id: string,
    revision: number,
    patch: Partial<Discovery>,
  ) {
    const ref = this.doc(workspaceId, 'discoveries', id);
    return this.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) throw new Error('discovery_missing');
      const current = DiscoverySchema.parse(snapshot.data());
      if (
        current.revision !== revision ||
        ['confirmed', 'cancelled', 'failed'].includes(current.status)
      )
        return undefined;
      const next = DiscoverySchema.parse({
        ...current,
        candidates: patch.candidates ?? current.candidates,
        recognition: patch.recognition ?? current.recognition,
        selectedBrandIndices:
          patch.selectedBrandIndices ?? current.selectedBrandIndices,
        relatedRequested: patch.relatedRequested ?? current.relatedRequested,
        selectedCandidateIndices: patch.selectedCandidateIndices,
        resolutionReason: patch.resolutionReason,
        failureReason: patch.failureReason,
        status: patch.status ?? current.status,
        ...(patch.cityOverride ? { cityOverride: patch.cityOverride } : {}),
        revision: revision + 1,
        updatedAt: new Date().toISOString(),
      });
      if (
        ![
          'needs_confirmation',
          'awaiting_brands',
          'needs_selection',
          'awaiting_city',
          'unresolved',
          'failed',
        ].includes(next.status)
      )
        throw new Error('discovery_transition_invalid');
      tx.set(ref, clean(next));
      return next;
    });
  }
  async finishDiscovery(
    workspaceId: string,
    id: string,
    revision: number,
    action: 'confirm' | 'cancel',
    selection?: {
      indices: number[];
      requestId: string;
      labels?: { index: number; label: string }[];
    },
  ) {
    const ref = this.doc(workspaceId, 'discoveries', id);
    return this.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) throw new Error('discovery_missing');
      const discovery = DiscoverySchema.parse(snapshot.data());
      if (
        discovery.revision !== revision ||
        ['confirmed', 'cancelled', 'failed'].includes(discovery.status)
      ) {
        const places = [];
        for (const placeId of discovery.confirmedPlaceIds ??
          (discovery.confirmedPlaceId ? [discovery.confirmedPlaceId] : [])) {
          const existing = await tx.get(
            this.doc(workspaceId, 'places', placeId),
          );
          if (existing.exists) places.push(PlaceSchema.parse(existing.data()));
        }
        return {
          discovery,
          changed: false,
          ...(places.length ? { place: places[0], places } : {}),
        };
      }
      if (
        selection &&
        (selection.indices.length > 8 ||
          new Set(selection.indices).size !== selection.indices.length ||
          selection.indices.some(
            (i) =>
              !Number.isInteger(i) || i < 0 || i >= discovery.candidates.length,
          ))
      )
        throw new Error('invalid_selection');
      const labels = (selection?.labels ?? []).map((l) =>
        SelectedLabelSchema.parse(l),
      );
      if (
        new Set(labels.map((l) => l.index)).size !== labels.length ||
        labels.some((l) => !selection?.indices.includes(l.index))
      )
        throw new Error('invalid_selection');
      const time = new Date().toISOString();
      const places: Place[] = [];
      let reused = 0;
      if (action === 'confirm') {
        const indices =
          selection &&
          ['needs_selection', 'needs_confirmation'].includes(discovery.status)
            ? selection.indices
            : discovery.status === 'needs_selection'
              ? (discovery.selectedCandidateIndices ?? [])
              : discovery.status === 'needs_confirmation' &&
                  discovery.candidates.length === 1
                ? [0]
                : [];
        if (!indices.length)
          throw new Error('deterministic_candidate_required');
        const entries = [
          ...new Map(
            indices.map((i) => {
              const candidate = discovery.candidates[i]!;
              const independent = candidate.relationship?.startsWith('related_')
                ? undefined
                : recognitionLabel(
                    discovery.recognition,
                    candidate.recognitionClueIndex,
                  );
              const user = labels.find((l) => l.index === i);
              const label = user
                ? { label: user.label, labelSource: 'user' as const }
                : independent;
              if (
                (discovery.source.provider === 'ai-chat' ||
                  discovery.recognition.mode === 'scene_viewpoint') &&
                (!label || !NewSavedLabelSchema.safeParse(label.label).success)
              )
                throw new Error('label_required');
              return [
                canonicalPlaceId(candidate),
                { candidate, label },
              ] as const;
            }),
          ).entries(),
        ];
        // Firestore requires all reads before any write; one bounded atomic transaction.
        const snapshots = [];
        for (const [placeId] of entries)
          snapshots.push(
            await tx.get(this.doc(workspaceId, 'places', placeId)),
          );
        const writes: {
          ref: ReturnType<FirestoreRepository['doc']>;
          place: Place;
        }[] = [];
        const enrichments: {
          ref: ReturnType<FirestoreRepository['doc']>;
          patch: {
            label?: string;
            labelSource?: Place['labelSource'];
            mapMetadata?: MapMetadata;
            updatedAt: string;
          };
        }[] = [];
        for (const [
          index,
          [placeId, { candidate, label }],
        ] of entries.entries()) {
          const placeRef = this.doc(workspaceId, 'places', placeId),
            existing = snapshots[index]!;
          const {
            resolution: _,
            localityIdentity: _localityIdentity,
            recognitionClueIndex,
            relationship: _relationship,
            candidateConfidence: _candidateConfidence,
            providerIdentity: identity,
            references,
            ...content
          } = candidate;
          // Strict durable schema also rejects accidental live Google content on all other write paths.
          // Application-owned map metadata (user city / Recognition category) only on a
          // Google Place; OSM keeps its independently licensed address/category.
          const mapMetadata =
            identity?.provider === 'google-places'
              ? mapMetadataFor(discovery, candidate)
              : undefined;
          const fields =
            identity?.provider === 'google-places'
              ? {
                  providerIdentity: identity,
                  ...(mapMetadata ? { mapMetadata } : {}),
                }
              : content;
          const source = references.find((r) =>
            identity
              ? r.provider === identity.provider && r.externalId === identity.id
              : r.provider !== 'openai-web-search',
          );
          if (!source || candidate.resolution !== 'deterministic_poi')
            throw new Error('deterministic_candidate_required');
          const stored = existing.exists
            ? PlaceSchema.parse(existing.data())
            : undefined;
          // A reused Google Place gains the same application-owned map metadata, but only
          // for fields it does not have yet: an existing city/category is never overwritten,
          // whatever its source. An authorized label fills only an unlabeled legacy
          // Google Place; existing labels and all other canonical fields are preserved.
          const missing =
            stored &&
            'providerIdentity' in stored &&
            stored.providerIdentity.provider === 'google-places'
              ? fillMissingMapMetadata(stored.mapMetadata, mapMetadata)
              : undefined;
          const missingLabel =
            stored &&
            'providerIdentity' in stored &&
            stored.providerIdentity.provider === 'google-places' &&
            stored.label === undefined &&
            label &&
            NewSavedLabelSchema.safeParse(label.label).success
              ? label
              : undefined;
          const enrichment =
            stored && (missing || missingLabel)
              ? {
                  ...(missing ? { mapMetadata: missing } : {}),
                  ...(missingLabel ?? {}),
                  updatedAt: time,
                }
              : undefined;
          if (enrichment)
            enrichments.push({ ref: placeRef, patch: enrichment });
          const place = stored
            ? enrichment
              ? PlaceSchema.parse({ ...stored, ...enrichment })
              : stored
            : PlaceSchema.parse({
                ...fields,
                ...(label ?? {}),
                id: placeId,
                workspaceId,
                source,
                evidence: references,
                status: 'confirmed',
                tags: [],
                createdAt: time,
                updatedAt: time,
              });
          places.push(place);
          if (existing.exists) reused++;
          else writes.push({ ref: placeRef, place });
        }
        for (const { ref, place } of writes) tx.create(ref, clean(place));
        for (const { ref, patch } of enrichments) tx.update(ref, clean(patch));
      }
      const next = DiscoverySchema.parse({
        ...discovery,
        status: action === 'confirm' ? 'confirmed' : 'cancelled',
        revision: revision + 1,
        ...(selection
          ? {
              completionReusedCount: reused,
              completionNewCount: places.length - reused,
              completionRequestId: selection.requestId,
              completionLabels: labels,
              selectedCandidateIndices: selection.indices,
            }
          : {}),
        ...(places.length
          ? {
              confirmedPlaceId: places[0]!.id,
              confirmedPlaceIds: places.map((p) => p.id),
            }
          : {}),
        updatedAt: time,
      });
      tx.set(ref, clean(next));
      return {
        discovery: next,
        changed: true,
        ...(places.length ? { place: places[0], places } : {}),
        reusedCount: reused,
      };
    });
  }
  async setArea(workspaceId: string, area: string) {
    await this.workspace(workspaceId).update({
      areaHint: area,
      updatedAt: new Date().toISOString(),
    });
  }
  async getDiscovery(workspaceId: string, id: string) {
    const s = await this.doc(workspaceId, 'discoveries', id).get();
    return s.exists ? DiscoverySchema.parse(s.data()) : undefined;
  }
  async createDiscovery(value: Discovery) {
    const discovery = DiscoverySchema.parse(value);
    const ref = this.doc(discovery.workspaceId, 'discoveries', discovery.id);
    return this.db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (s.exists) return DiscoverySchema.parse(s.data());
      tx.create(ref, clean(discovery));
      return discovery;
    });
  }
  async savePlace(value: Place) {
    const place = PlaceSchema.parse(value);
    await this.doc(place.workspaceId, 'places', place.id).set(clean(place));
  }
  async getPlace(workspaceId: string, id: string) {
    const s = await this.doc(workspaceId, 'places', id).get();
    return s.exists ? PlaceSchema.parse(s.data()) : undefined;
  }
  async saveChain(workspaceId: string, value: Chain) {
    const chain = ChainSchema.parse(value);
    await this.doc(workspaceId, 'chains', chain.id).set(clean(chain));
  }
  async getChain(workspaceId: string, id: string) {
    const s = await this.doc(workspaceId, 'chains', id).get();
    return s.exists ? ChainSchema.parse(s.data()) : undefined;
  }
}
function clean(value: object): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value));
}

export function canonicalPlaceId(
  candidate: Candidate | StoredCandidate,
): string {
  const key = candidate.providerIdentity
    ? `poi:${candidate.providerIdentity.provider}:${candidate.providerIdentity.id}`
    : 'coordinates' in candidate
      ? `geo:${candidate.canonicalName.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ')}:${candidate.coordinates.latitude.toFixed(6)}:${candidate.coordinates.longitude.toFixed(6)}`
      : undefined;
  if (!key) throw new Error('deterministic_candidate_required');
  return createHash('sha256').update(key).digest('hex');
}
