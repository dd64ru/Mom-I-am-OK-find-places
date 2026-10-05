import { createHash, randomUUID } from 'node:crypto';
import { DiscoveryService, type PlacesRepository } from '@places/core';
import type { Discovery } from '@places/schemas';
import type { AtomicDocuments } from '@places/providers';
import type { AcceptedMessage } from '@places/worker';
import type { TelegramTransport } from './telegram-api.js';
const LIFETIME = 24 * 60 * 60 * 1000,
  CITY_LIFETIME = 10 * 60 * 1000;
interface Interaction {
  discoveryId: string;
  revision: number;
  expiresAt: number;
  phase: 'active' | 'processing' | 'done' | 'prompt';
  messageId?: number;
  userId?: number;
  replyId?: number;
  city?: string;
  action?: 'confirm' | 'city' | 'cancel';
  owner?: string;
  leaseUntil?: number;
}
export class TelegramInteractions {
  constructor(
    private readonly docs: AtomicDocuments,
    private readonly repository: PlacesRepository,
    private readonly service: DiscoveryService,
    private readonly api: TelegramTransport,
    private readonly workspace: string,
    private readonly chat: number,
    private readonly now = Date.now,
  ) {}
  private token(discovery: Discovery, kind = 'proposal') {
    return createHash('sha256')
      .update(`${kind}:${this.workspace}:${discovery.id}:${discovery.revision}`)
      .digest('hex')
      .slice(0, 32);
  }
  private path(token: string) {
    return `workspaces/${this.workspace}/telegramInteractions/${token}`;
  }
  private promptPath(id: number) {
    return `workspaces/${this.workspace}/cityPrompts/${id}`;
  }
  private async discovery(state: Interaction) {
    return this.repository.getDiscovery(this.workspace, state.discoveryId);
  }
  private async close(messageId?: number) {
    if (messageId)
      await this.api.call('editMessageReplyMarkup', {
        chat_id: this.chat,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      });
  }
  async propose(discovery: Discovery, userId: number, replyTo: number) {
    if (['confirmed', 'cancelled'].includes(discovery.status)) return;
    if (!discovery.recognition.clues.length) {
      await this.api.call('sendMessage', {
        chat_id: this.chat,
        text: 'Could not identify the place. Please resend a clearer screenshot.',
        reply_parameters: { message_id: replyTo },
      });
      return;
    }
    const token = this.token(discovery);
    const state = await this.docs.change<Interaction>(
      this.path(token),
      (raw) => {
        if (raw) return { result: raw as unknown as Interaction };
        const state: Interaction = {
          discoveryId: discovery.id,
          revision: discovery.revision,
          expiresAt: this.now() + LIFETIME,
          phase: 'active',
        };
        return { value: { ...state }, result: state };
      },
    );
    if (!state.messageId && state.phase === 'active') {
      const candidate =
        discovery.candidates.length === 1 ? discovery.candidates[0] : undefined;
      const buttons = {
        inline_keyboard: [
          [
            ...(candidate
              ? [{ text: '✅ Confirm', callback_data: `p:${token}:c` }]
              : []),
            { text: '✏️ Change city', callback_data: `p:${token}:e` },
            { text: '❌ Cancel', callback_data: `p:${token}:x` },
          ],
        ],
      };
      const common = {
        chat_id: this.chat,
        reply_parameters: { message_id: replyTo },
        reply_markup: buttons,
      };
      const attribution = '© OpenStreetMap contributors (ODbL)';
      const message =
        candidate && candidate.address.formatted
          ? await this.api.call('sendVenue', {
              ...common,
              latitude: candidate.coordinates.latitude,
              longitude: candidate.coordinates.longitude,
              title: candidate.canonicalName.slice(0, 250),
              address: `${candidate.address.formatted.slice(0, 800)}\n${attribution}`,
            })
          : await this.api.call('sendMessage', {
              ...common,
              text: candidate
                ? `${candidate.canonicalName.slice(0, 300)}\n${candidate.address.city ?? ''}\n${candidate.coordinates.latitude}, ${candidate.coordinates.longitude}\n${attribution}`
                : 'Could not resolve this place confidently. Please specify or change its city; no Place has been saved.',
            });
      await this.docs.change(this.path(token), (raw) => ({
        value: { ...raw, messageId: message.message_id },
        result: undefined,
      }));
    }
    if (discovery.status === 'awaiting_city' && !discovery.cityOverride)
      await this.prompt(discovery, userId, replyTo);
  }
  private async prompt(discovery: Discovery, userId: number, replyTo: number) {
    const token = this.token(discovery, 'prompt');
    const state = await this.docs.change<Interaction>(
      this.path(token),
      (raw) => {
        if (raw) return { result: raw as unknown as Interaction };
        const next: Interaction = {
          discoveryId: discovery.id,
          revision: discovery.revision,
          expiresAt: this.now() + CITY_LIFETIME,
          phase: 'prompt',
          userId,
        };
        return { value: { ...next }, result: next };
      },
    );
    let messageId = state.messageId;
    if (!messageId) {
      const message = await this.api.call('sendMessage', {
        chat_id: this.chat,
        text: 'Which city is this place in? Reply directly to this message (up to 200 characters, within 10 minutes).',
        reply_parameters: { message_id: replyTo },
        reply_markup: {
          force_reply: true,
          selective: true,
          input_field_placeholder: 'City or region',
        },
      });
      messageId = Number(message.message_id);
      await this.docs.change(this.path(token), (raw) => ({
        value: { ...raw, messageId },
        result: undefined,
      }));
    }
    await this.docs.change(this.promptPath(messageId), (raw) => ({
      value: raw ?? { token },
      result: undefined,
    }));
  }
  async canReply(
    reply: Extract<AcceptedMessage, { kind: 'cityReply' }>,
  ): Promise<string | undefined> {
    const token = await this.docs.change(
      this.promptPath(reply.promptId),
      (raw) => ({
        result: typeof raw?.token === 'string' ? raw.token : undefined,
      }),
    );
    if (!token) return;
    const state = await this.docs.change<Interaction | undefined>(
      this.path(token),
      (raw) => ({ result: raw as unknown as Interaction | undefined }),
    );
    if (
      !state ||
      state.expiresAt <= this.now() ||
      state.messageId !== reply.promptId ||
      state.userId !== reply.userId ||
      !(
        state.phase === 'prompt' ||
        (state.phase === 'processing' && state.replyId === reply.messageId)
      )
    )
      return;
    const discovery = await this.discovery(state);
    if (
      !discovery ||
      ['confirmed', 'cancelled'].includes(discovery.status) ||
      discovery.revision < state.revision ||
      discovery.revision > state.revision + 2
    )
      return;
    if (
      state.phase === 'prompt' &&
      (discovery.status !== 'awaiting_city' ||
        discovery.revision !== state.revision)
    )
      return;
    return token;
  }
  private async claim(
    token: string,
    check: (state: Interaction) => boolean,
    fields: Partial<Interaction>,
  ) {
    const owner = randomUUID();
    const state = await this.docs.change<Interaction | undefined>(
      this.path(token),
      (raw) => {
        const state = raw as unknown as Interaction | undefined;
        if (
          !state ||
          state.expiresAt <= this.now() ||
          state.phase === 'done' ||
          !check(state)
        )
          return { result: undefined };
        if (
          state.phase === 'processing' &&
          Number(state.leaseUntil) > this.now()
        )
          throw new Error('interaction_busy');
        const next = {
          ...state,
          ...fields,
          phase: 'processing' as const,
          owner,
          leaseUntil: this.now() + 330_000,
        };
        return { value: { ...next }, result: next };
      },
    );
    return state ? { state, owner } : undefined;
  }
  private async done(token: string, owner: string) {
    await this.docs.change(this.path(token), (raw) => {
      if (raw?.owner !== owner || Number(raw.leaseUntil) <= this.now())
        throw new Error('interaction_lease_lost');
      return {
        value: { ...raw, phase: 'done', leaseUntil: 0 },
        result: undefined,
      };
    });
  }
  private async release(token: string, owner: string) {
    await this.docs.change(this.path(token), (raw) =>
      raw?.owner === owner
        ? { value: { ...raw, leaseUntil: 0 }, result: undefined }
        : { result: undefined },
    );
  }
  async canCallback(
    callback: Extract<AcceptedMessage, { kind: 'callback' }>,
  ): Promise<boolean> {
    if (!/^[a-f0-9]{32}$/.test(callback.token)) return false;
    const state = await this.docs.change<Interaction | undefined>(
      this.path(callback.token),
      (raw) => ({ result: raw as unknown as Interaction | undefined }),
    );
    if (
      !state ||
      state.expiresAt <= this.now() ||
      state.messageId !== callback.messageId ||
      !['active', 'processing'].includes(state.phase)
    )
      return false;
    const discovery = await this.discovery(state);
    if (!discovery) return false;
    if (state.phase === 'active')
      return (
        discovery.revision === state.revision &&
        !['confirmed', 'cancelled'].includes(discovery.status)
      );
    return (
      state.action === callback.action &&
      state.userId === callback.userId &&
      (discovery.revision === state.revision ||
        (discovery.revision === state.revision + 1 &&
          (callback.action === 'city'
            ? discovery.status === 'awaiting_city'
            : ['confirmed', 'cancelled'].includes(discovery.status))))
    );
  }
  async callback(
    callback: Extract<AcceptedMessage, { kind: 'callback' }>,
    acknowledged = false,
  ) {
    // Acknowledge before Firestore/network verification. No raw payload in text or diagnostics.
    if (!acknowledged)
      await this.api.call('answerCallbackQuery', {
        callback_query_id: callback.callbackId,
        text: 'Received. Expired or already handled actions will be ignored.',
      });
    if (!(await this.canCallback(callback))) return;
    const claimed = await this.claim(
      callback.token,
      (state) =>
        state.messageId === callback.messageId &&
        (state.phase === 'active' ||
          (state.action === callback.action &&
            state.userId === callback.userId)),
      { action: callback.action, userId: callback.userId },
    );
    if (!claimed) return;
    const { state, owner } = claimed;
    try {
      let discovery = await this.discovery(state);
      if (!discovery) {
        await this.done(callback.token, owner);
        return;
      }
      if (callback.action === 'city') {
        if (discovery.revision === state.revision)
          discovery = await this.service.requestCity(discovery);
        if (
          !discovery ||
          discovery.status !== 'awaiting_city' ||
          discovery.revision !== state.revision + 1
        ) {
          await this.done(callback.token, owner);
          return;
        }
        await this.close(state.messageId);
        await this.prompt(discovery, callback.userId, callback.messageId);
      } else {
        const result = await this.repository.finishDiscovery(
          this.workspace,
          discovery.id,
          state.revision,
          callback.action,
        );
        if (
          result.changed ||
          ['confirmed', 'cancelled'].includes(result.discovery.status)
        ) {
          await this.close(state.messageId);
          await this.api.call('sendMessage', {
            chat_id: this.chat,
            text: result.changed
              ? result.place
                ? 'Confirmed — added to your places.'
                : 'Cancelled. No Place was added.'
              : 'Already handled.',
            reply_parameters: { message_id: callback.messageId },
          });
        }
      }
      await this.done(callback.token, owner);
    } catch (error) {
      await this.release(callback.token, owner);
      throw error;
    }
  }
  async cityReply(
    reply: Extract<AcceptedMessage, { kind: 'cityReply' }>,
    token: string,
  ) {
    const claimed = await this.claim(
      token,
      (state) =>
        state.userId === reply.userId &&
        state.messageId === reply.promptId &&
        (state.phase === 'prompt' || state.replyId === reply.messageId),
      { replyId: reply.messageId, city: reply.city },
    );
    if (!claimed) return;
    const { state, owner } = claimed;
    try {
      let discovery = await this.discovery(state);
      if (!discovery || ['confirmed', 'cancelled'].includes(discovery.status)) {
        await this.done(token, owner);
        return;
      }
      if (discovery.revision === state.revision)
        discovery = await this.service.correctCity(discovery, state.city!);
      else if (
        discovery.revision === state.revision + 1 &&
        discovery.cityOverride === state.city
      )
        discovery = await this.service.resolve(discovery);
      else if (
        discovery.revision !== state.revision + 2 ||
        discovery.cityOverride !== state.city
      )
        discovery = undefined;
      if (discovery) {
        const oldToken = this.token({ ...discovery, revision: state.revision });
        const oldMessage = await this.docs.change(
          this.path(oldToken),
          (raw) => ({
            result:
              typeof raw?.messageId === 'number' ? raw.messageId : undefined,
          }),
        );
        await this.close(oldMessage);
        await this.propose(discovery, reply.userId, reply.messageId);
      }
      await this.done(token, owner);
    } catch (error) {
      await this.release(token, owner);
      throw error;
    }
  }
}
