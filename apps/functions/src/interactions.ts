import { CitySessions } from './city-sessions.js';
import { createHash, randomUUID } from 'node:crypto';
import { DiscoveryService, type PlacesRepository } from '@places/core';
import {
  MAX_SEARCH_BRANDS,
  type Discovery,
  type DiscoveryView,
  type ProviderFailureReason,
} from '@places/schemas';
import type { AtomicDocuments } from '@places/providers';
import type { AcceptedMessage } from '@places/worker';
import { ProcessingStatus } from './processing-status.js';
import { ingressId } from './ingress.js';
import type { TelegramTransport } from './telegram-api.js';
const LIFETIME = 24 * 60 * 60 * 1000,
  CITY_LIFETIME = 10 * 60 * 1000;
export const MAX_SHORTLIST_CONTINUATIONS = 3;
export const MAX_SHORTLIST_MESSAGES = MAX_SHORTLIST_CONTINUATIONS + 1;
const CREDITS_PER_CANDIDATE = 3;
interface TextEntity {
  type: 'text_link';
  offset: number;
  length: number;
  url: string;
}
interface ShortlistText {
  text: string;
  entities: TextEntity[];
}
interface Interaction {
  discoveryId: string;
  revision: number;
  expiresAt: number;
  phase: 'active' | 'processing' | 'done' | 'prompt';
  messageId?: number;
  continuationMessageIds?: number[];
  userId?: number;
  replyId?: number;
  city?: string;
  action?:
    | 'confirm'
    | 'city'
    | 'cancel'
    | 'select'
    | 'all'
    | 'clear'
    | 'search'
    | 'brands'
    | 'related';
  selectionIndex?: number;
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
  private token(
    discovery: Pick<Discovery, 'id' | 'revision'>,
    kind = 'proposal',
  ) {
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
  private async cleanupContinuations(state: Interaction) {
    // Tokens carry the original IDs through checkbox revisions. Legacy markers
    // can be read by bounded index; neither path needs provider content.
    const ids = new Set<number>();
    try {
      if (state.continuationMessageIds) {
        for (const id of state.continuationMessageIds.slice(
          0,
          MAX_SHORTLIST_CONTINUATIONS,
        ))
          ids.add(id);
      } else {
        for (let page = 0; page < MAX_SHORTLIST_CONTINUATIONS; page++) {
          const path = this.path(
            this.token(
              { id: state.discoveryId, revision: state.revision },
              `multi-text-${page}`,
            ),
          );
          const id = await this.docs.change(path, (raw) => ({
            result: raw?.messageId,
          }));
          if (typeof id === 'number') ids.add(id);
        }
      }
    } catch {
      /* Cleanup metadata is best effort, too. */
    }
    for (const messageId of ids) {
      try {
        await this.api.call('deleteMessage', {
          chat_id: this.chat,
          message_id: messageId,
        });
      } catch {
        try {
          await this.api.call('editMessageText', {
            chat_id: this.chat,
            message_id: messageId,
            text: 'Этот список больше не активен. Используй текущую карточку места.',
            entities: [],
            reply_markup: { inline_keyboard: [] },
          });
        } catch {
          /* An unavailable/expired Telegram message must not poison confirmation. */
        }
      }
    }
  }
  async propose(
    discovery: DiscoveryView,
    userId: number,
    replyTo: number,
    statusId = discovery.id,
  ): Promise<void | { failureReason: ProviderFailureReason }> {
    if (discovery.status === 'failed') {
      await new CitySessions(
        this.docs,
        this.repository,
        this.workspace,
        this.chat,
        this.now,
      ).deactivateDiscovery(discovery.id);
      await new ProcessingStatus(
        this.docs,
        this.api,
        this.workspace,
        this.chat,
      ).failure(statusId);
      return { failureReason: discovery.failureReason! };
    }
    if (['confirmed', 'cancelled'].includes(discovery.status)) return;
    if (!discovery.recognition.clues.length) {
      await this.api.call('sendMessage', {
        chat_id: this.chat,
        text: 'Не удалось определить место. Пришли более чёткий скриншот.',
        reply_parameters: { message_id: replyTo },
      });
      return;
    }
    if (discovery.status === 'awaiting_brands')
      return this.brands(discovery, replyTo);
    if (discovery.status === 'awaiting_city' && !discovery.cityOverride) {
      await this.prompt(discovery, userId, replyTo);
      return;
    }
    if (
      discovery.status === 'needs_selection' &&
      discovery.candidates.length === 1 &&
      discovery.recognition.mode !== 'recommendation_list'
    ) {
      const revised = await this.repository.reviseDiscovery(
        this.workspace,
        discovery.id,
        discovery.revision,
        { status: 'needs_confirmation', selectedCandidateIndices: undefined },
      );
      if (revised) return this.propose(revised, userId, replyTo, statusId);
      return;
    }
    if (discovery.status === 'needs_selection')
      return this.shortlist(discovery, userId, replyTo, statusId);
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
      const candidate = await this.service.displayCandidate(discovery);
      if (!candidate) {
        const current = await this.repository.getDiscovery(
          this.workspace,
          discovery.id,
        );
        if (current?.status === 'failed')
          return this.propose(current, userId, replyTo, statusId);
      }
      const buttons = {
        inline_keyboard: [
          [
            ...(candidate
              ? [{ text: '✅ Добавить', callback_data: `p:${token}:c` }]
              : []),
            { text: '✏️ Изменить город', callback_data: `p:${token}:e` },
            { text: '❌ Отмена', callback_data: `p:${token}:x` },
          ],
          ...this.discoveryButtons(discovery, token),
        ],
      };
      const common = {
        chat_id: this.chat,
        reply_parameters: { message_id: replyTo },
        reply_markup: buttons,
      };
      const google = candidate?.providerIdentity?.provider === 'google-places';
      const attribution = google
        ? [
            'Источник: Google Maps',
            ...(candidate?.attributions ?? []).map((a) => renderAttribution(a)),
          ].join('\n')
        : '© Участники OpenStreetMap (ODbL)';
      const confidenceText = google
        ? candidate?.relationship?.startsWith('related_')
          ? 'Потенциально связанное место (не подтверждённая принадлежность к сети). Уверенность низкая — проверь на карте и подтверди.'
          : candidate?.candidateConfidence === 'high'
            ? 'Уверенность: высокая. Похоже, это именно оно. Проверь место на карте и подтверди.'
            : `${candidate?.candidateConfidence === 'medium' ? 'Уверенность: средняя.' : 'Уверенность: низкая.'} Нашёл возможный вариант. Но это не точно 🙂 Проверь место на карте и подтверди.`
        : '';
      const message =
        candidate && !google && candidate.address.formatted
          ? await this.api.call('sendVenue', {
              ...common,
              latitude: candidate.coordinates.latitude,
              longitude: candidate.coordinates.longitude,
              title: candidate.canonicalName.slice(0, 250),
              address: `${candidate.address.formatted.slice(0, 800)}\n${attribution}`,
            })
          : await this.api.call('sendMessage', {
              ...common,
              text: (candidate
                ? `${confidenceText ? confidenceText + '\n' : ''}${candidate.canonicalName.slice(0, 300)}\n${google ? 'Город по данным Google: ' : ''}${candidate.address.city ?? 'не указан'}${google && candidate.address.providerContext ? '\nРегион по данным Google (не подтверждённый город): ' + compact(candidate.address.providerContext, 100) : ''}\n${google ? candidate.address.formatted.slice(0, 1500) : candidate.coordinates.latitude + ', ' + candidate.coordinates.longitude}\n${attribution}${google ? '\n' + (candidate.references.find((r) => r.provider === 'google-places')?.url ?? '') : ''}`
                : resolutionMessage(discovery)
              ).slice(0, 4000),
            });
      await this.docs.change(this.path(token), (raw) => ({
        value: { ...raw, messageId: message.message_id },
        result: undefined,
      }));
    }
  }
  private discoveryButtons(discovery: Discovery, token: string) {
    if (discovery.recognition.mode === 'recommendation_list')
      return [
        [{ text: '📋 Изменить выбор брендов', callback_data: `p:${token}:b` }],
      ];
    const offered =
      !discovery.relatedRequested &&
      discovery.status === 'needs_confirmation' &&
      discovery.candidates.length === 1 &&
      discovery.candidates[0]?.providerIdentity?.provider === 'google-places';
    try {
      console.info(
        JSON.stringify({
          event: 'optional_related_discovery',
          outcome: offered ? 'offered' : 'not_offered',
        }),
      );
    } catch {
      /* best effort */
    }
    return offered
      ? [
          [
            {
              text: '🔎 Найти другие / похожие места',
              callback_data: `p:${token}:r`,
            },
          ],
        ]
      : [];
  }
  private async brands(
    discovery: Discovery,
    replyTo: number,
    editMessageId?: number,
  ) {
    const root = this.token(discovery, 'brands');
    const already = await this.docs.change(this.path(root), (raw) => ({
      result: raw?.messageId,
    }));
    if (already && !editMessageId) return;
    const selected = new Set(discovery.selectedBrandIndices ?? []);
    const keyboard = discovery.recognition.clues.map((c, i) => [
      {
        text: `${selected.has(i) ? '☑️' : '☐'} ${i + 1}. ${compact(c.name, 45)}`,
        callback_data: `p:${this.token(discovery, `brand-${i}`)}:s`,
      },
    ]);
    if (discovery.recognition.clues.length <= MAX_SEARCH_BRANDS)
      keyboard.push([{ text: 'Выбрать все', callback_data: `p:${root}:a` }]);
    keyboard.push([{ text: 'Снять выбор', callback_data: `p:${root}:z` }]);
    if (selected.size)
      keyboard.push([
        {
          text: `🔎 Искать выбранные (${selected.size})`,
          callback_data: `p:${root}:q`,
        },
      ]);
    keyboard.push([{ text: '❌ Отмена', callback_data: `p:${root}:x` }]);
    const body = {
      chat_id: this.chat,
      reply_markup: { inline_keyboard: keyboard },
    };
    const sent = editMessageId
      ? await this.api.call('editMessageReplyMarkup', {
          ...body,
          message_id: editMessageId,
        })
      : await this.api.call('sendMessage', {
          ...body,
          reply_parameters: { message_id: replyTo },
          text: `Нашёл публичные рекомендации. Выбери до ${MAX_SEARCH_BRANDS} брендов для отдельных поисков в твоём городе. Остальные можно выбрать отдельной попыткой — «Изменить выбор брендов». Ничего не сохраняется автоматически.\n\n${discovery.recognition.clues.map((c, i) => `${i + 1}. ${compact(c.name, 120)}${c.confidence < 0.8 ? ' (название требует проверки)' : ''}`).join('\n')}${discovery.recognition.recommendationsTruncated ? '\nПоказаны первые восемь рекомендаций; для остальных пришли отдельный фрагмент списка.' : ''}`,
        });
    const messageId = editMessageId ?? Number(sent.message_id);
    for (const [i, token] of [
      root,
      ...discovery.recognition.clues.map((_, i) =>
        this.token(discovery, `brand-${i}`),
      ),
    ].entries())
      await this.docs.change(this.path(token), (raw) => ({
        value: raw ?? {
          discoveryId: discovery.id,
          revision: discovery.revision,
          expiresAt: this.now() + LIFETIME,
          phase: 'active',
          messageId,
          ...(i ? { selectionIndex: i - 1 } : {}),
        },
        result: undefined,
      }));
  }
  private async shortlist(
    discovery: DiscoveryView,
    userId: number,
    replyTo: number,
    statusId: string,
    editMessageId?: number,
    controlsOnly = false,
    continuationMessageIds: number[] = [],
  ) {
    continuationMessageIds = continuationMessageIds.slice(
      0,
      MAX_SHORTLIST_CONTINUATIONS,
    );
    const rootToken = this.token(discovery, 'multi');
    const existing = await this.docs.change(this.path(rootToken), (raw) => ({
      result: raw?.messageId,
    }));
    if (existing && !editMessageId) return;
    const selected = new Set(discovery.selectedCandidateIndices ?? []);
    const cards: ShortlistText[] = [],
      overview: string[] = [],
      keyboard: { text: string; callback_data: string }[][] = [];
    const tokens = [rootToken];
    for (let index = 0; index < discovery.candidates.length; index++) {
      const token = this.token(discovery, `selection-${index}`);
      tokens.push(token);
      if (!controlsOnly) {
        const candidate = await this.service.displayCandidate(discovery, index);
        if (!candidate) {
          const current = await this.repository.getDiscovery(
            this.workspace,
            discovery.id,
          );
          if (current?.status === 'failed')
            return this.propose(current, userId, replyTo, statusId);
          return;
        }
        const link =
          candidate.references.find((r) => r.provider === 'google-places')
            ?.url ?? '';
        const relation =
          discovery.recognition.mode === 'recommendation_list'
            ? 'Возможное место по рекомендации; уверенность низкая — проверь на карте'
            : candidate.relationship === 'likely_exact'
              ? 'Вероятно место с фото'
              : candidate.relationship?.startsWith('related_')
                ? 'Потенциально связанное место (предположение)'
                : 'Возможный вариант';
        const brand =
          discovery.recognition.mode === 'recommendation_list'
            ? discovery.recognition.clues[
                discovery.candidates[index]?.recognitionClueIndex ?? -1
              ]?.name
            : undefined;
        const group = brand ? `Рекомендация: ${compact(brand, 60)}\n` : '';
        overview.push(
          `${group}${index + 1}. ${compact(candidate.canonicalName, 80)} — ${relation}`,
        );
        const card: ShortlistText = {
          text: `${group}${index + 1}. ${compact(candidate.canonicalName, 80)} — ${relation}\nГород по данным Google: ${candidate.address.city ? compact(candidate.address.city, 40) : 'не указан'}${candidate.address.providerContext ? '\nРегион Google (город не подтверждён): ' + compact(candidate.address.providerContext, 80) : ''}\n${compact(candidate.address.formatted, 80)}\nИсточник: `,
          entities: [],
        };
        appendLink(card, 'Google Maps', link);
        const credits = candidate.attributions ?? [];
        for (const credit of credits.slice(0, CREDITS_PER_CANDIDATE)) {
          card.text += '\n';
          appendLink(
            card,
            compact(
              credit.provider.replace(/[\u0000-\u001f\u007f]/gu, ' '),
              160,
            ),
            safeAttributionUri(credit.providerUri),
          );
        }
        if (
          credits.length > CREDITS_PER_CANDIDATE ||
          credits.some((c) => c.provider.length > 160)
        ) {
          card.text += `\nАтрибуция сокращена (${credits.length} источников); подробнее: `;
          appendLink(card, 'Google Maps', link);
        }
        cards.push(card);
      }
      keyboard.push([
        {
          text: `${selected.has(index) ? '☑️' : '☐'} ${index + 1}`,
          callback_data: `p:${token}:s`,
        },
      ]);
    }
    keyboard.push([
      { text: 'Выбрать все', callback_data: `p:${rootToken}:a` },
      { text: 'Снять выбор', callback_data: `p:${rootToken}:z` },
    ]);
    if (selected.size)
      keyboard.push([
        {
          text: `✅ Добавить выбранные (${selected.size})`,
          callback_data: `p:${rootToken}:c`,
        },
      ]);
    keyboard.push(...this.discoveryButtons(discovery, rootToken));
    keyboard.push([
      { text: '✏️ Изменить город', callback_data: `p:${rootToken}:e` },
      { text: '❌ Отмена', callback_data: `p:${rootToken}:x` },
    ]);
    const intro =
      discovery.recognition.mode === 'recommendation_list'
        ? 'Места по выбранным рекомендациям сгруппированы по брендам. Проверь варианты на карте и выбери конкретные места. Сохранение — только после «Добавить выбранные».'
        : 'Нашёл несколько возможных мест. Проверь варианты на карте. Места сохраняются только после «Добавить выбранные».';
    let messageId = editMessageId;
    if (controlsOnly) {
      await this.api.call('editMessageReplyMarkup', {
        chat_id: this.chat,
        message_id: messageId,
        reply_markup: { inline_keyboard: keyboard },
      });
    } else {
      // Long credits use numbered continuation messages belonging to this menu.
      // Only the final message has controls; no provider text is persisted.
      const pages = shortlistPages(intro, cards);
      const continuations = pages.length > 1 ? pages : [];
      for (let page = 0; page < continuations.length; page++) {
        const path = this.path(this.token(discovery, `multi-text-${page}`));
        const sentAlready = await this.docs.change(path, (raw) => ({
          result: raw?.messageId,
        }));
        if (typeof sentAlready === 'number') {
          continuationMessageIds.push(sentAlready);
          continue;
        }
        const sent = await this.api.call('sendMessage', {
          chat_id: this.chat,
          reply_parameters: { message_id: replyTo },
          text: continuations[page]!.text,
          entities: continuations[page]!.entities,
          link_preview_options: { is_disabled: true },
        });
        await this.docs.change(path, (raw) => ({
          value: raw ?? { messageId: sent.message_id },
          result: undefined,
        }));
        continuationMessageIds.push(Number(sent.message_id));
      }
      const sent = await this.api.call(
        editMessageId ? 'editMessageText' : 'sendMessage',
        {
          chat_id: this.chat,
          ...(editMessageId
            ? { message_id: editMessageId }
            : { reply_parameters: { message_id: replyTo } }),
          text:
            pages.length > 1
              ? `${intro}\n\n${overview.join('\n')}\n\nАдреса, Maps-ссылки и источники — в сообщениях выше.`
              : pages[0]!.text,
          entities: pages.length > 1 ? [] : pages[0]!.entities,
          link_preview_options: { is_disabled: true },
          reply_markup: { inline_keyboard: keyboard },
        },
      );
      messageId = editMessageId ?? Number(sent.message_id);
    }
    for (const [i, token] of tokens.entries())
      await this.docs.change(this.path(token), (raw) => ({
        value: raw ?? {
          discoveryId: discovery.id,
          revision: discovery.revision,
          expiresAt: this.now() + LIFETIME,
          phase: 'active',
          messageId,
          ...(continuationMessageIds.length ? { continuationMessageIds } : {}),
          ...(i ? { selectionIndex: i - 1 } : {}),
        },
        result: undefined,
      }));
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
    await new CitySessions(
      this.docs,
      this.repository,
      this.workspace,
      this.chat,
      this.now,
    ).deactivateDiscovery(discovery.id, token, discovery.revision);
    let messageId = state.messageId;
    if (!messageId) {
      const message = await this.api.call('sendMessage', {
        chat_id: this.chat,
        text: `${discovery.resolutionReason === 'ambiguous_locality' ? 'Нашлось несколько похожих мест. Уточни город. ' : ''}В каком городе находится это место? Ответь на это сообщение или напиши город следующим сообщением (до 200 символов, в течение 10 минут).`,
        reply_parameters: { message_id: replyTo },
        reply_markup: {
          force_reply: true,
          selective: true,
          input_field_placeholder: 'Город или регион',
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
    await new CitySessions(
      this.docs,
      this.repository,
      this.workspace,
      this.chat,
      this.now,
    ).register(state.userId!, {
      token,
      messageId,
      discoveryId: discovery.id,
      revision: discovery.revision,
      expiresAt: state.expiresAt,
    });
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
    if (state && state.expiresAt <= this.now())
      await new CitySessions(
        this.docs,
        this.repository,
        this.workspace,
        this.chat,
        this.now,
      ).deactivate(reply.userId, token);
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
      ['confirmed', 'cancelled', 'failed'].includes(discovery.status) ||
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
    const completed = await this.docs.change<Interaction>(
      this.path(token),
      (raw) => {
        if (raw?.owner !== owner || Number(raw.leaseUntil) <= this.now())
          throw new Error('interaction_lease_lost');
        return {
          value: { ...raw, phase: 'done', leaseUntil: 0 },
          result: raw as unknown as Interaction,
        };
      },
    );
    const sessions = new CitySessions(
      this.docs,
      this.repository,
      this.workspace,
      this.chat,
      this.now,
    );
    if (completed.replyId !== undefined && completed.userId)
      await sessions.deactivate(completed.userId, token);
    if (completed.action === 'confirm' || completed.action === 'cancel')
      await sessions.deactivateDiscovery(completed.discoveryId);
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
        !['confirmed', 'cancelled', 'failed'].includes(discovery.status) &&
        (callback.action !== 'select' ||
          (state.selectionIndex !== undefined &&
            ['needs_selection', 'awaiting_brands'].includes(
              discovery.status,
            ))) &&
        (!['all', 'clear'].includes(callback.action) ||
          ['needs_selection', 'awaiting_brands'].includes(discovery.status)) &&
        (callback.action !== 'all' ||
          discovery.status !== 'awaiting_brands' ||
          discovery.recognition.clues.length <= MAX_SEARCH_BRANDS) &&
        (callback.action !== 'search' ||
          (discovery.status === 'awaiting_brands' &&
            !!discovery.selectedBrandIndices?.length)) &&
        (callback.action !== 'brands' ||
          discovery.recognition.mode === 'recommendation_list') &&
        (callback.action !== 'related' ||
          (discovery.recognition.mode !== 'recommendation_list' &&
            !discovery.relatedRequested &&
            discovery.status === 'needs_confirmation' &&
            discovery.candidates.length === 1 &&
            discovery.candidates[0]?.providerIdentity?.provider ===
              'google-places')) &&
        (callback.action !== 'confirm' ||
          discovery.status === 'needs_confirmation' ||
          (discovery.status === 'needs_selection' &&
            !!discovery.selectedCandidateIndices?.length))
      );
    return (
      state.action === callback.action &&
      state.userId === callback.userId &&
      (discovery.revision === state.revision ||
        (['search', 'related'].includes(callback.action) &&
          discovery.revision >= state.revision + 1 &&
          discovery.revision <= state.revision + 2) ||
        (callback.action === 'brands' &&
          discovery.revision === state.revision + 1 &&
          discovery.status === 'awaiting_brands') ||
        (discovery.revision === state.revision + 1 &&
          (callback.action === 'city'
            ? discovery.status === 'awaiting_city'
            : ['select', 'all', 'clear'].includes(callback.action)
              ? ['needs_selection', 'awaiting_brands'].includes(
                  discovery.status,
                )
              : ['confirmed', 'cancelled', 'failed'].includes(
                  discovery.status,
                ))))
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
        text: 'Запрос получен. Просроченные и уже обработанные действия пропускаются.',
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
      if (
        callback.action === 'select' ||
        callback.action === 'all' ||
        callback.action === 'clear'
      ) {
        if (discovery.revision === state.revision)
          discovery = await (
            discovery.status === 'awaiting_brands'
              ? this.service.updateBrandSelection.bind(this.service)
              : this.service.updateSelection.bind(this.service)
          )(
            discovery,
            callback.action === 'select' ? 'toggle' : callback.action,
            state.selectionIndex,
          );
        if (
          discovery?.revision === state.revision + 1 &&
          ['needs_selection', 'awaiting_brands'].includes(discovery.status)
        ) {
          if (discovery.status === 'awaiting_brands') {
            await this.brands(discovery, callback.messageId, state.messageId);
            await this.done(callback.token, owner);
            return;
          }
          console.info(
            JSON.stringify({
              event: 'place_selection',
              selectedCount: discovery.selectedCandidateIndices?.length ?? 0,
            }),
          );
          await this.shortlist(
            discovery,
            callback.userId,
            callback.messageId,
            discovery.id,
            state.messageId,
            true,
            state.continuationMessageIds,
          );
        }
      } else if (['search', 'brands', 'related'].includes(callback.action)) {
        if (discovery.revision === state.revision) {
          discovery =
            callback.action === 'search'
              ? await this.service.searchBrands(discovery)
              : callback.action === 'brands'
                ? await this.service.requestBrands(discovery)
                : await this.service.requestRelated(discovery);
        } else if (
          discovery.revision === state.revision + 1 &&
          callback.action !== 'brands' &&
          discovery.status !== 'awaiting_city'
        ) {
          discovery = await this.service.resolve(discovery);
        }
        if (discovery && discovery.revision > state.revision) {
          await this.cleanupContinuations(state);
          await this.close(state.messageId);
          await this.propose(discovery, callback.userId, callback.messageId);
        }
      } else if (callback.action === 'city') {
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
        await this.cleanupContinuations(state);
        await this.close(state.messageId);
        await this.prompt(discovery, callback.userId, callback.messageId);
      } else if (
        callback.action === 'confirm' ||
        callback.action === 'cancel'
      ) {
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
          console.info(
            JSON.stringify({
              event: 'place_bulk_confirmation',
              confirmedCount: result.places?.length ?? (result.place ? 1 : 0),
              reusedCount: 'reusedCount' in result ? result.reusedCount : 0,
            }),
          );
          await this.cleanupContinuations(state);
          await this.close(state.messageId);
          await this.api.call('sendMessage', {
            chat_id: this.chat,
            text: result.changed
              ? result.place
                ? result.places && result.places.length > 1
                  ? `Добавлено мест: ${result.places.length}.`
                  : 'Добавлено в сохранённые места.'
                : 'Отменено. Место не добавлено.'
              : 'Это действие уже обработано.',
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
    const status = new ProcessingStatus(
      this.docs,
      this.api,
      this.workspace,
      this.chat,
    );
    const logicalId = ingressId(
      this.workspace,
      this.chat,
      `cityReply-${reply.messageId}`,
    );
    await status.start(logicalId, reply.messageId, 'city');
    try {
      let discovery = await this.discovery(state);
      if (discovery?.status === 'failed') {
        await status.failure(logicalId);
        await this.done(token, owner);
        return { failureReason: discovery.failureReason! };
      }
      if (!discovery || ['confirmed', 'cancelled'].includes(discovery.status)) {
        await status.complete(logicalId);
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
      if (discovery?.status === 'failed') {
        await status.failure(logicalId);
        await this.done(token, owner);
        return { failureReason: discovery.failureReason! };
      }
      await status.complete(logicalId);
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
        const outcome = await this.propose(
          discovery,
          reply.userId,
          reply.messageId,
          logicalId,
        );
        if (outcome) {
          await this.done(token, owner);
          return outcome;
        }
      }
      await this.done(token, owner);
    } catch (error) {
      await this.release(token, owner);
      throw error;
    }
  }
}

function resolutionMessage(discovery: Discovery): string {
  if (discovery.status === 'awaiting_city')
    return discovery.cityOverride
      ? 'После уточнения города место всё ещё не удалось определить однозначно. Место не сохранено. Можно изменить город или отменить.'
      : discovery.resolutionReason === 'ambiguous_locality'
        ? 'Нашлось несколько похожих мест. Уточни город. Ответь на сообщение ниже названием города. Место не сохранено.'
        : 'Не удалось уверенно определить город. Ответь на сообщение ниже названием города. Место не сохранено.';
  const reasons: Record<string, string> = {
    locality_conflict:
      'Указанный город противоречит найденной информации о месте.',
    locality_mismatch: 'Найденные места не соответствуют указанному городу.',
    unsupported_category: 'Этот тип места пока не поддерживается.',
    ambiguous_poi: 'Нашлось несколько похожих мест. Уточни город.',
    insufficient_evidence: 'Не удалось уверенно определить конкретное место.',
    no_match: 'Не удалось найти подходящее место.',
    no_place_evidence: 'Не удалось уверенно определить конкретное место.',
  };
  return `${reasons[discovery.resolutionReason ?? ''] ?? 'Не удалось уверенно определить это место.'} Место не сохранено. Можно изменить город или отменить.`;
}

export function renderAttribution(
  value: {
    provider: string;
    providerUri?: string;
  },
  full = false,
) {
  const provider = value.provider.replace(/[\u0000-\u001f\u007f]/gu, ' ');
  const label = full ? provider : provider.slice(0, 1000);
  try {
    const url = new URL(value.providerUri ?? '');
    if (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      url.href.length < 1500
    )
      return label + (full ? '\n' : ' ') + url.href;
  } catch {
    /* Not every documented URI is a safe clickable web URL. */
  }
  return label;
}

// UTF-16 budgets are conservative for Telegram, including non-BMP text.
function compact(value: string, budget: number) {
  value = value
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
      '\uFFFD',
    );
  if (value.length <= budget) return value;
  let end = budget - 1;
  if (/[\uD800-\uDBFF]/u.test(value[end - 1] ?? '')) end--;
  return value.slice(0, end) + '…';
}
function safeAttributionUri(value?: string): string | undefined {
  if (!value || value.length >= 1500) return;
  try {
    const url = new URL(value ?? '');
    if (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      url.href.length < 1500
    )
      return url.href;
  } catch {
    /* Provider URI validity and safe display are separate. */
  }
}
function appendLink(target: ShortlistText, label: string, url?: string) {
  if (url)
    target.entities.push({
      type: 'text_link',
      offset: target.text.length,
      length: label.length,
      url,
    });
  target.text += label;
}
function combineText(prefix: string, cards: ShortlistText[]): ShortlistText {
  const result: ShortlistText = { text: prefix, entities: [] };
  for (const card of cards) {
    result.text += '\n\n';
    const offset = result.text.length;
    result.entities.push(
      ...card.entities.map((e) => ({ ...e, offset: e.offset + offset })),
    );
    result.text += card.text;
  }
  return result;
}
function shortlistPages(
  intro: string,
  cards: ShortlistText[],
): ShortlistText[] {
  const combined = combineText(intro, cards);
  if (combined.text.length <= 3800) return [combined];
  // Each card has fixed field/credit/independent-brand budgets (< 1200 UTF-16 units). Three
  // cards per page and the eight-candidate domain bound mean at most 3 pages.
  const pages: ShortlistText[] = [];
  for (let page = 0; page < MAX_SHORTLIST_CONTINUATIONS; page++) {
    const group = cards.slice(page * 3, page * 3 + 3);
    if (!group.length) break;
    pages.push(combineText(`Варианты и источники (${page + 1})`, group));
  }
  return pages;
}
