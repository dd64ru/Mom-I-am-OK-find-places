import { randomUUID } from 'node:crypto';
import type { Firestore } from '@google-cloud/firestore';
export interface AtomicDocuments {
  change<T>(
    path: string,
    fn: (value: Record<string, unknown> | undefined) => {
      value?: Record<string, unknown>;
      result: T;
    },
  ): Promise<T>;
}
export class FirestoreDocuments implements AtomicDocuments {
  constructor(private readonly db: Firestore) {}
  async change<T>(
    path: string,
    fn: (value: Record<string, unknown> | undefined) => {
      value?: Record<string, unknown>;
      result: T;
    },
  ): Promise<T> {
    return this.db.runTransaction(async (tx) => {
      const ref = this.db.doc(path);
      const snapshot = await tx.get(ref);
      const next = fn(snapshot.exists ? snapshot.data() : undefined);
      if (next.value) tx.set(ref, next.value);
      return next.result;
    });
  }
}
export class RefreshLease {
  private owner?: string;
  constructor(
    private readonly documents: AtomicDocuments,
    private readonly path = '_runtime/openai-refresh',
    private readonly now = Date.now,
    private readonly wait = (ms: number) =>
      new Promise<void>((r) => setTimeout(r, ms)),
  ) {}
  async run<T>(operation: () => Promise<T>): Promise<T> {
    const owner = randomUUID();
    const deadline = this.now() + 25_000;
    while (true) {
      const acquired = await this.documents.change(this.path, (state) => {
        if (
          state?.blocked ||
          (state?.phase === 'refreshing' &&
            Number(state.expiresAt) <= this.now())
        )
          throw new Error('openai_reauthorization_required');
        if (Number(state?.expiresAt ?? 0) > this.now())
          return { result: false };
        return {
          value: {
            ...state,
            owner,
            expiresAt: this.now() + 120_000,
            phase: 'reserved',
          },
          result: true,
        };
      });
      if (acquired) break;
      if (this.now() >= deadline) throw new Error('openai_refresh_busy');
      await this.wait(250);
    }
    this.owner = owner;
    try {
      return await operation();
    } finally {
      this.owner = undefined;
      await this.documents.change(this.path, (state) => {
        if (state?.owner !== owner) return { result: undefined };
        // An interrupted/ambiguous refresh must not replay a possibly consumed rotating token.
        return {
          value: {
            expiresAt: 0,
            blocked: state.phase === 'refreshing',
            ...(typeof state.sessionVersion === 'string'
              ? { sessionVersion: state.sessionVersion }
              : {}),
          },
          result: undefined,
        };
      });
    }
  }
  async version(): Promise<string | undefined> {
    return this.documents.change(this.path, (state) => ({
      result:
        typeof state?.sessionVersion === 'string'
          ? state.sessionVersion
          : undefined,
    }));
  }
  async checkpoint(version: string) {
    const owner = this.owner;
    await this.documents.change(this.path, (state) => {
      if (
        !owner ||
        state?.owner !== owner ||
        Number(state.expiresAt) <= this.now()
      )
        throw new Error('openai_refresh_lease_lost');
      return {
        value: { ...state, sessionVersion: version },
        result: undefined,
      };
    });
  }
  async phase(phase: 'reserved' | 'refreshing') {
    const owner = this.owner;
    if (!owner) throw new Error('openai_refresh_lease_required');
    await this.documents.change(this.path, (state) => {
      if (state?.owner !== owner || Number(state.expiresAt) <= this.now())
        throw new Error('openai_refresh_lease_lost');
      return { value: { ...state, phase }, result: undefined };
    });
  }
}
// Bound concurrent image memory across requests/revisions without an external queue.
export async function imageSlot<T>(
  docs: AtomicDocuments,
  operation: (assertOwned: () => Promise<void>) => Promise<T>,
  now = Date.now,
): Promise<T> {
  const path = '_runtime/image-slot',
    owner = randomUUID();
  await docs.change(path, (state) => {
    if (Number(state?.expiresAt ?? 0) > now())
      throw new Error('image_runtime_busy');
    return { value: { owner, expiresAt: now() + 330_000 }, result: undefined };
  });
  const assertOwned = async () => {
    await docs.change(path, (state) => {
      if (state?.owner !== owner || Number(state.expiresAt) <= now())
        throw new Error('image_slot_lost');
      return { result: undefined };
    });
  };
  try {
    return await operation(assertOwned);
  } finally {
    await docs.change(path, (state) =>
      state?.owner === owner
        ? { value: { expiresAt: 0 }, result: undefined }
        : { result: undefined },
    );
  }
}
