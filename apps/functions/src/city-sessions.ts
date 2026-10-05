import { z } from 'zod';
import type { AtomicDocuments } from '@places/providers';
import type { PlacesRepository } from '@places/core';
import type { AcceptedMessage } from '@places/worker';
const Entry = z
  .object({
    token: z.string().regex(/^[a-f0-9]{32}$/),
    messageId: z.number().int().safe().positive(),
    discoveryId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    revision: z.number().int().nonnegative(),
    expiresAt: z.number().finite(),
    replyId: z.number().int().safe().nonnegative().optional(),
  })
  .strict();
const Pointer = z
  .object({
    prompts: z.array(Entry).max(16),
    blockedUntil: z.number().finite().optional(),
  })
  .strict();
const Owners = z
  .object({
    users: z.array(z.number().int().safe().positive()).max(16),
    blockedUntil: z.number().finite().optional(),
  })
  .strict();
type Prompt = z.infer<typeof Entry>;
export class CitySessions {
  constructor(
    private readonly docs: AtomicDocuments,
    private readonly repository: PlacesRepository,
    private readonly workspace: string,
    private readonly chat: number,
    private readonly now = Date.now,
  ) {}
  private path(user: number) {
    return `workspaces/${this.workspace}/citySessions/${this.chat}_${user}`;
  }
  private owners(id: string) {
    return `workspaces/${this.workspace}/citySessionOwners/${id}`;
  }
  async register(user: number, prompt: Prompt) {
    Entry.parse(prompt);
    await this.docs.change(this.owners(prompt.discoveryId), (raw) => {
      const previous = raw ? Owners.parse(raw) : { users: [] };
      const users = [...new Set([...previous.users, user])];
      return {
        value: {
          users: users.slice(0, 16),
          ...(users.length > 16
            ? { blockedUntil: prompt.expiresAt }
            : previous.blockedUntil
              ? { blockedUntil: previous.blockedUntil }
              : {}),
        },
        result: undefined,
      };
    });
    await this.docs.change(this.path(user), (raw) => {
      const previous = raw ? Pointer.parse(raw) : { prompts: [] };
      if (
        previous.prompts.some(
          (p) =>
            p.discoveryId === prompt.discoveryId &&
            p.revision > prompt.revision,
        )
      )
        return { result: undefined };
      const existing = previous.prompts.find((p) => p.token === prompt.token);
      const prompts = previous.prompts.filter(
        (p) => p.expiresAt > this.now() && p.discoveryId !== prompt.discoveryId,
      );
      const blockedUntil = Math.max(
        previous.blockedUntil ?? 0,
        prompts.length >= 16 ? prompt.expiresAt : 0,
      );
      if (prompts.length < 16)
        prompts.push({
          ...prompt,
          ...(existing?.replyId !== undefined
            ? { replyId: existing.replyId }
            : {}),
        });
      return {
        value: {
          prompts,
          ...(blockedUntil > this.now() ? { blockedUntil } : {}),
        },
        result: undefined,
      };
    });
  }
  async deactivate(user: number, token: string) {
    await this.docs.change(this.path(user), (raw) => {
      if (!raw) return { result: undefined };
      const pointer = Pointer.parse(raw);
      return {
        value: {
          ...pointer,
          prompts: pointer.prompts.filter(
            (p) => p.token !== token && p.expiresAt > this.now(),
          ),
        },
        result: undefined,
      };
    });
  }
  async deactivateDiscovery(
    id: string,
    keepToken?: string,
    beforeRevision?: number,
  ) {
    const owners = await this.docs.change(this.owners(id), (raw) => ({
      result: raw ? Owners.parse(raw) : undefined,
    }));
    for (const user of owners?.users ?? [])
      await this.docs.change(this.path(user), (raw) => {
        if (!raw) return { result: undefined };
        const pointer = Pointer.parse(raw);
        return {
          value: {
            ...pointer,
            prompts: pointer.prompts.filter(
              (p) =>
                (p.discoveryId !== id ||
                  p.token === keepToken ||
                  (beforeRevision !== undefined &&
                    p.revision > beforeRevision)) &&
                p.expiresAt > this.now(),
            ),
          },
          result: undefined,
        };
      });
  }
  async resolve(
    text: Extract<AcceptedMessage, { kind: 'cityText' }>,
  ): Promise<Extract<AcceptedMessage, { kind: 'cityReply' }> | undefined> {
    const pointer = await this.docs.change(this.path(text.userId), (raw) => ({
      result: raw ? Pointer.parse(raw) : undefined,
    }));
    if (!pointer) return;
    const valid: Prompt[] = [];
    for (const prompt of pointer.prompts) {
      const d =
        prompt.expiresAt > this.now()
          ? await this.repository.getDiscovery(
              this.workspace,
              prompt.discoveryId,
            )
          : undefined;
      if (
        d &&
        !['confirmed', 'cancelled', 'failed'].includes(d.status) &&
        (prompt.replyId !== undefined
          ? d.revision >= prompt.revision && d.revision <= prompt.revision + 2
          : d.status === 'awaiting_city' && d.revision === prompt.revision)
      )
        valid.push(prompt);
    }
    const accepted = await this.docs.change<Prompt | undefined>(
      this.path(text.userId),
      (raw) => {
        if (!raw) return { result: undefined };
        const current = Pointer.parse(raw);
        // Preserve prompts registered after the read, but never accept an unvalidated new one.
        const prompts = current.prompts.filter(
          (p) =>
            p.expiresAt > this.now() &&
            (!pointer.prompts.some((old) => old.token === p.token) ||
              valid.some((v) => v.token === p.token)),
        );
        const blocked = (current.blockedUntil ?? 0) > this.now();
        const changed = prompts.some(
          (p) => !valid.some((v) => v.token === p.token),
        );
        const retry = prompts.find((p) => p.replyId === text.messageId);
        const selected =
          retry ??
          (!blocked &&
          !changed &&
          prompts.length === 1 &&
          prompts[0]!.replyId === undefined
            ? prompts[0]
            : undefined);
        if (selected) selected.replyId = text.messageId;
        return {
          value: {
            prompts,
            ...(blocked ? { blockedUntil: current.blockedUntil } : {}),
          },
          result: selected,
        };
      },
    );
    if (accepted)
      return {
        kind: 'cityReply',
        messageId: text.messageId,
        userId: text.userId,
        promptId: accepted.messageId,
        city: text.city,
      };
  }
}
