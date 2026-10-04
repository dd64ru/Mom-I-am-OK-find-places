import { createHash, randomUUID } from 'node:crypto';
import type { AtomicDocuments } from '@places/providers';
import type { AcceptedMessage } from '@places/worker';
export interface IngressRecord {
  phase: 'pending' | 'processing' | 'done';
  sealed?: boolean;
  messageId: number;
  fileIds: string[];
  quietAt: number;
  owner?: string;
  expiresAt?: number;
}
export const ingressId = (workspace: string, chat: number, source: string) =>
  createHash('sha256').update(`${workspace}:${chat}:${source}`).digest('hex');
export class Ingress {
  constructor(
    private readonly docs: AtomicDocuments,
    private readonly workspace: string,
    private readonly now = Date.now,
    private readonly wait = (ms: number) =>
      new Promise<void>((r) => setTimeout(r, ms)),
  ) {}
  private path(id: string) {
    return `workspaces/${this.workspace}/pendingIngress/${id}`;
  }
  async receive(chat: number, accepted: AcceptedMessage): Promise<string> {
    const source =
      accepted.kind === 'image'
        ? (accepted.albumId ?? `message-${accepted.messageId}`)
        : `command-${accepted.messageId}`;
    let id = ingressId(this.workspace, chat, source);
    const record = await this.docs.change(this.path(id), (raw) => {
      const state = raw as unknown as IngressRecord | undefined;
      const file = accepted.kind === 'image' ? accepted.fileId : undefined;
      if (state) {
        if (!file || state.fileIds.includes(file))
          return { result: 'existing' };
        // A sealed album cannot change underneath an inference. Preserve late members individually.
        if (
          state.phase !== 'pending' ||
          state.sealed ||
          state.fileIds.length >= 10
        )
          return { result: 'late' };
      }
      const next: IngressRecord = state ?? {
        phase: 'pending',
        messageId: accepted.messageId,
        fileIds: [],
        quietAt: this.now(),
      };
      if (file) next.fileIds.push(file);
      next.messageId = Math.min(next.messageId, accepted.messageId);
      next.quietAt =
        this.now() + (accepted.kind === 'image' && accepted.albumId ? 1500 : 0);
      return {
        value: next as unknown as Record<string, unknown>,
        result: 'stored',
      };
    });
    if (record === 'late') {
      id = await this.receive(chat, {
        ...accepted,
        ...(accepted.kind === 'image' ? { albumId: undefined } : {}),
      });
    }
    return id;
  }
  async run(
    id: string,
    process: (
      record: IngressRecord,
      assertOwned: () => Promise<void>,
    ) => Promise<void>,
  ): Promise<'done' | 'retry'> {
    const owner = randomUUID();
    const deadline = this.now() + 20_000;
    while (true) {
      const claim = await this.docs.change<
        { kind: 'done' | 'wait' } | { kind: 'claim'; state: IngressRecord }
      >(this.path(id), (raw) => {
        const state = raw as unknown as IngressRecord;
        if (state.phase === 'done')
          return { result: { kind: 'done' as const } };
        if (
          state.quietAt > this.now() ||
          (state.phase === 'processing' && Number(state.expiresAt) > this.now())
        )
          return { result: { kind: 'wait' as const } };
        const next = {
          ...state,
          phase: 'processing' as const,
          sealed: true,
          owner,
          expiresAt: this.now() + 330_000,
        };
        return { value: next, result: { kind: 'claim' as const, state: next } };
      });
      if (claim.kind === 'done') return 'done';
      if (claim.kind === 'claim') {
        const assertOwned = async () => {
          await this.docs.change(this.path(id), (raw) => {
            if (raw?.owner !== owner || Number(raw.expiresAt) <= this.now())
              throw new Error('ingress_lease_lost');
            return { result: undefined };
          });
        };
        try {
          await process(claim.state, assertOwned);
          await this.docs.change(this.path(id), (raw) => {
            if (raw?.owner !== owner || Number(raw.expiresAt) <= this.now())
              throw new Error('ingress_lease_lost');
            return {
              value: { ...raw, phase: 'done', owner: '', expiresAt: 0 },
              result: undefined,
            };
          });
          return 'done';
        } catch (error) {
          await this.docs.change(this.path(id), (raw) =>
            raw?.owner === owner
              ? {
                  value: { ...raw, phase: 'pending', owner: '', expiresAt: 0 },
                  result: undefined,
                }
              : { result: undefined },
          );
          throw error;
        }
      }
      if (this.now() >= deadline) return 'retry';
      await this.wait(250);
    }
  }
}
