import { createHash } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import {
  IdSchema,
  WorkspaceSchema,
  PlaceSchema,
  ChainSchema,
  DiscoverySchema,
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
        const existing = discovery.confirmedPlaceId
          ? await tx.get(
              this.doc(workspaceId, 'places', discovery.confirmedPlaceId),
            )
          : undefined;
        return {
          discovery,
          changed: false,
          ...(existing?.exists
            ? { place: PlaceSchema.parse(existing.data()) }
            : {}),
        };
      }
      const time = new Date().toISOString();
      let place: Place | undefined;
      if (action === 'confirm') {
        if (
          discovery.status !== 'needs_confirmation' ||
          discovery.candidates.length !== 1
        )
          throw new Error('deterministic_candidate_required');
        const candidate = discovery.candidates[0]!;
        const placeId = canonicalPlaceId(candidate);
        const placeRef = this.doc(workspaceId, 'places', placeId);
        const existing = await tx.get(placeRef);
        const {
          resolution: _,
          providerIdentity: identity,
          references,
          ...content
        } = candidate;
        // Strict durable schema also rejects accidental live Google content on all other write paths.
        const fields =
          identity?.provider === 'google-places'
            ? { providerIdentity: identity }
            : content;
        const source = references.find((r) =>
          identity
            ? r.provider === identity.provider && r.externalId === identity.id
            : r.provider !== 'openai-web-search',
        );
        if (!source || candidate.resolution !== 'deterministic_poi')
          throw new Error('deterministic_candidate_required');
        place = existing.exists
          ? PlaceSchema.parse(existing.data())
          : PlaceSchema.parse({
              ...fields,
              id: placeId,
              workspaceId,
              source,
              evidence: references,
              status: 'confirmed',
              tags: [],
              createdAt: time,
              updatedAt: time,
            });
        if (!existing.exists) tx.create(placeRef, clean(place));
      }
      const next = DiscoverySchema.parse({
        ...discovery,
        status: action === 'confirm' ? 'confirmed' : 'cancelled',
        revision: revision + 1,
        ...(place ? { confirmedPlaceId: place.id } : {}),
        updatedAt: time,
      });
      tx.set(ref, clean(next));
      return { discovery: next, changed: true, ...(place ? { place } : {}) };
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
