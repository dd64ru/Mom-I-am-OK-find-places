# Telegram adapter and MVP UX

Before setting the allowlist, use the [privacy-safe ID diagnostic](diagnostics.md#telegram-ids); stop the worker while it polls. It prints permitted group/sender metadata and never creates configuration automatically.

Set exactly one negative group/supergroup `TELEGRAM_CHAT_ID` and positive permitted `TELEGRAM_USER_IDS`. Both chat and sender must match before file retrieval, AI, persistence or replies. Channel posts, anonymous senders, bots, edits, service messages, other chats and other users are ignored. The allowed-updates poller requests only `message` updates. Addressed commands for another bot are ignored.

Accepted inputs:

- Photos: choose the largest Telegram photo size.
- Image documents: JPEG, PNG or WebP only; downloaded bytes must have the corresponding supported signature. Maximum 5 MiB per image, 25 MiB per batch, 10 images.
- `/help`: lists current operations.
- `/area <city or region>`: stores a bounded optional workspace hint. It is a hint, never geographic proof.

Other text, unsupported commands, captions and unsupported media are ignored. The bot reads no surrounding conversation. In group privacy mode Telegram may not deliver unaddressed image messages: the owner must configure BotFather group privacy appropriately or give the bot the necessary group access. Application allowlists remain mandatory even when Telegram delivers more messages. No message content or upstream request/error object is logged.

## Albums and persistence

Updates with the same chat/media-group ID buffer together until 1.5 seconds of inactivity (configurable 0.5–5 seconds). Repeated file IDs collapse, pending albums are capped at 20, and batches process sequentially with a bounded queue. Graceful shutdown drains buffered batches. Telegram supplies no explicit album-complete event; this is a timing heuristic. An exceptionally late image after an already-created discovery will be treated as the same source and not re-analyzed. A future durable ingestion design should track individual image IDs and album revisions.

Completed discovery writes use a stable hash of chat plus media-group/message ID, with a Firestore transaction preventing duplicate records. Response delivery can still duplicate after retries. Albums awaiting processing live only in memory; polling acknowledgement is not transactional with Firestore. Crashes or a full buffer can drop images; resend failed images. This limitation is acceptable for the foundation and must be hardened before promising reliable unattended ingestion.

Responses show possible names and confidence and explicitly say verification/confirmation is pending. No personality, conversational follow-up or silently guessed point is generated. Images stay in memory; Firestore retains only image source references and extracted evidence.

## Planned commands (currently ignored)

| Command                                 | Intended behavior                                                       |
| --------------------------------------- | ----------------------------------------------------------------------- |
| `/find <area> <query>`                  | Explicit POI search; return verified candidates for confirmation        |
| `/branches <area>` replying to a result | Resolve stored chainId and search branches without new vision inference |
| `/map`                                  | Open/export the member workspace's confirmed place collection           |
| `/undo`                                 | Archive the last supported creation, retaining provenance               |

A future confirmation operation will atomically write the selected verified Place and chain link and map the bot's reply message to its domain result. The current adapter does not store a reply-to-place mapping or support these commands.

Official transport reference: [Telegram Bot API](https://core.telegram.org/bots/api), inspected 2026-10-04. The implementation uses grammy for polling and Telegram methods; no webhook or public HTTP service is required.
