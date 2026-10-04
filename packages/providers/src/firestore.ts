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
