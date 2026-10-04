# Operational diagnostics

Run from the repository root after `npm ci && npm run build`, using Node.js 22.9+. Commands load `.env` if present; a future VM can use its non-secret environment/systemd configuration without any `.env` file. Paths are ordinary filesystem paths, not platform-specific constants. For machine-readable output use `npm run --silent ...` to suppress npm's own banner.

| Command                                | Required access/settings                                         | Output                                                                    |
| -------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `npm run check`                        | None                                                             | Credential-free fixture/mocked checks; no live service calls              |
| `npm run models`                       | Protected SIWC profile; `OPENAI_SESSION_DIR`, `OPENAI_PROFILE`   | Current account model slugs/names; no model or reasoning setting required |
| `npm run vision:smoke -- <image-path>` | Same SIWC profile; `OPENAI_MODEL`, `OPENAI_REASONING_EFFORT`     | One validated Recognition JSON object                                     |
| `npm run telegram:ids`                 | Telegram token via `SECRET_SOURCE`; Google ADC only for `google` | Group/member metadata JSON lines until Ctrl+C                             |

## Model and reasoning

Choose `OPENAI_MODEL` from **your current** `npm run models` catalog. Do not assume another account's or a generic example's model is available. `OPENAI_REASONING_EFFORT` is independent: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; it defaults to `low` only when omitted. Empty/invalid values fail validation; no silent substitution occurs. All OpenAI vision Responses requests include `reasoning: { effort: <configured value> }`.

The [current reasoning guide](https://developers.openai.com/api/docs/guides/reasoning) and [Responses request reference](https://developers.openai.com/api/reference/resources/responses/methods/create), inspected 2026-10-04, define these values and explain model-dependent support. The catalog check establishes model availability, not universal effort/image support. HTTP 400 surfaces the fixed diagnostic `openai_request_options_rejected`: check the chosen model's effort/image support and request inputs. The application never retries with a different effort or switches to Gemini for this rejection.

## Vision smoke

Reuse the owner's already-authorized protected profile; no repeat OAuth is necessary while that session remains usable. Set its directory/profile, choose an available image-capable model and set the desired effort. Example invocation:

```sh
npm run vision:smoke -- ./place.png
```

Exactly one regular `.jpg`, `.jpeg`, `.png` or `.webp` file is accepted. Extension and byte signature must agree, and the file must be at most 5 MiB, matching Telegram's per-image limit. Unsupported/oversized files fail before credential or network access. The CLI acquires the existing exclusive session lock, validates the model catalog, calls the real SIWC Responses vision provider, and prints only validated Recognition JSON. It never starts Telegram, Firestore, Firebase, Google authentication, Secret Manager or Gemini fallback. A stopped worker/other session owner is required; clean completion releases the lock.

Output can contain text extracted from your image; keep private diagnostic output out of this public repository and CI artifacts. Errors are fixed safe codes, never tokens, credential contents, headers, raw SSE events or upstream bodies. This task tested mocked requests only; the owner runs this command with real credentials to verify live vision.

## Telegram IDs

For `SECRET_SOURCE=google`, the local setup identity or future VM runtime identity needs ADC and `roles/secretmanager.secretAccessor` on the existing `TELEGRAM_BOT_TOKEN` secret in `mom-im-ok-places`. No Firestore access or Gemini secret is needed. For `SECRET_SOURCE=env`, explicitly supply `TELEGRAM_BOT_TOKEN` through a private local environment/ignored `.env`; no Google credentials are required. Never put it on the command line or in GitHub/CI.

Stop the normal production worker and **every other getUpdates poller for this bot** before starting `npm run telegram:ids`. Send one harmless message/image to the intended private group from each intended user. Copy the numeric chat ID and sender IDs manually into non-secret runtime configuration, then stop with Ctrl+C. Group privacy mode must permit the bot to receive those messages; configure BotFather access if needed. Do not use real private conversation as a test message.

Only human-sender group/supergroup updates produce output: chat ID/type/title, sender ID/username/display name, and a high-level event kind. Token values or Bot API URLs embedded in display labels are redacted. Text/captions are not emitted, media is never downloaded, and raw updates/token-containing URLs are never logged. The CLI keeps only a temporary in-memory polling offset, writes no application files/Firestore data, invokes no AI and creates no allowlist. getUpdates advances the polling offset: updates acknowledged by this diagnostic will not reach the worker. The last received batch can be redelivered if you stop before the next poll acknowledges it. Errors stop the diagnostic with fixed codes; a conflict indicates another bot poller. No diagnostic output should be committed.

## Permanent ownership

| Location                             | Owns                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| GitHub                               | Application source                                                                   |
| VM environment/systemd configuration | Non-secret model/effort, workspace/chat/user IDs and secret-source selection         |
| Google Secret Manager                | `TELEGRAM_BOT_TOKEN`, `GEMINI_API_KEY`                                               |
| Protected persistent VM directory    | VM host identity, imported SIWC account profile, rotating access/refresh credentials |
| Firestore                            | Canonical application data                                                           |

The laptop is a setup tool. The permanent runtime does not depend on it. Before transferring the authorized profile, create/persist the VM's own host ID; securely copy **only the selected profile credential file**, preserving the VM's host identity. The VM becomes the sole refresh owner. Diagnostics on that VM use the same protected directory while the worker is stopped. Follow [the existing SIWC VM procedure](openai-siwc.md#persistent-vm-setup), which was rechecked against current official guidance. Never upload SIWC files to Secret Manager, Codex environment variables, GitHub, CI artifacts or logs. No automatic upload, infrastructure provisioning or new cloud token storage is implemented.
