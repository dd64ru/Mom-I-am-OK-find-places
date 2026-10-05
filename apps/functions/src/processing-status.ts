import type { AtomicDocuments } from '@places/providers';
import type { TelegramTransport } from './telegram-api.js';
// The send claim is durable BEFORE the external send. Retries never send another status.
// A crash after send/before recording its ID can leave an orphan; no exactly-once Telegram API exists.
export class ProcessingStatus {
  constructor(
    private readonly docs: AtomicDocuments,
    private readonly api: TelegramTransport,
    private readonly workspace: string,
    private readonly chat: number,
  ) {}
  private path(id: string) {
    return `workspaces/${this.workspace}/pendingIngress/${id}/status/processing`;
  }
  async start(id: string, replyTo: number, kind: 'image' | 'city' = 'image') {
    try {
      const send = await this.docs.change(this.path(id), (raw) =>
        raw ? { result: false } : { value: { claimed: true }, result: true },
      );
      if (!send) return;
      const sent = await this.api.call('sendMessage', {
        chat_id: this.chat,
        text: kind === 'city' ? '🔎 Уточняю место…' : '🔎 Ищу место…',
        reply_parameters: { message_id: replyTo },
      });
      if (Number.isSafeInteger(sent.message_id))
        await this.docs.change(this.path(id), (raw) => ({
          value: { ...raw, messageId: sent.message_id },
          result: undefined,
        }));
    } catch {
      /* UI acknowledgement is best effort; never retry expensive processing for its failure. */
    }
  }
  async failure(id: string) {
    try {
      const state = await this.docs.change<{ messageId?: number } | undefined>(
        this.path(id),
        (raw) =>
          raw?.errorClaimed
            ? { result: undefined }
            : {
                value: { ...raw, claimed: true, errorClaimed: true },
                result: {
                  ...(typeof raw?.messageId === 'number'
                    ? { messageId: raw.messageId }
                    : {}),
                },
              },
      );
      if (!state) return;
      const text =
        '⚠️ Не удалось обработать место из-за ошибки сервиса. Попробуй ещё раз позже.';
      if (state.messageId) {
        try {
          await this.api.call('editMessageText', {
            chat_id: this.chat,
            message_id: state.messageId,
            text,
          });
          return;
        } catch {
          await this.complete(id);
        }
      }
      await this.api.call('sendMessage', { chat_id: this.chat, text });
    } catch {
      /* Terminal acknowledgement is best effort and never repeats expensive work. */
    }
  }
  async complete(id: string) {
    try {
      const messageId = await this.docs.change(this.path(id), (raw) => ({
        result: typeof raw?.messageId === 'number' ? raw.messageId : undefined,
      }));
      if (messageId)
        await this.api.call('deleteMessage', {
          chat_id: this.chat,
          message_id: messageId,
        });
    } catch {
      /* Deletion failure must never fail or retry the place pipeline. */
    }
  }
}
