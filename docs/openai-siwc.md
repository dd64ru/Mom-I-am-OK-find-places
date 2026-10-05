# OpenAI Sign in with ChatGPT

Official documentation inspected on 2026-10-05. This preview can change; revisit these references before deployment:

- [OSS registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Profiles, refresh and session security](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Current Responses restrictions](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [OIDC discovery](https://auth.openai.com/.well-known/openid-configuration)

## Implemented procedure

1. Copy `.env.example` to `.env`. Set `OPENAI_SESSION_DIR` to private persistent storage and choose `OPENAI_PROFILE=owner`. Runtime settings can remain empty while authorizing. Use a different profile label for each additional account/workspace registration; do not repurpose an existing profile for another identity.
2. Run `npm run oauth` (its source pre-hook builds current code) on the computer where the browser runs. The CLI obtains an exclusive runtime lock, persists a stable `urn:uuid:...` host ID, and starts an ephemeral-port listener on `127.0.0.1` before displaying the authorization URL. Open that URL privately. No real OAuth was run during repository bootstrap.
3. First registration uses `dynamic_agent_client`, the stable host ID, consistent app name, fresh state/nonce, S256 PKCE, exact loopback `/auth/callback`, resource `https://api.openai.com/v1`, and `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct` scopes.
4. The returned issued client ID, not `dynamic_agent_client`, is used to exchange the code without a client secret. State, expiry of the attempt and replay are checked. The ID token is verified against official JWKS for signature, issuer, audience, expiration and nonce. Its verified subject and issued client ID remain paired. Returning sign-in cannot replace the registration with a different client ID or subject.
5. Granted scopes authorize plan usage. The whole credential set is atomically written with `0600` files in a `0700` directory. Access, rotating refresh and ID tokens never enter Firestore. The CLI omits retained ID-token/login hints from its displayed URL to avoid printing tokens; returning login therefore uses the normal account selector. The OAuth boundary supports those hints for a future private browser-launch UI.
6. Run `npm run models` before import and choose an available account model. Production validates once per cold instance before its first image inference. An unavailable model fails with `openai_model_unavailable`; successfully initialized instances do not query the catalog per batch. Runtime auth/model rejection does not switch providers.
7. Local diagnostics hold an exclusive file lock. Production uses explicit Secret Manager session reads/writes and a Firestore refresh lease, rereading latest after acquisition and preserving the rotating replacement. See [serverless operations](../infra/README.md) for import, ambiguous refresh recovery and sole-owner requirements.

An authorization attempt is single-use. After denied authorization, invalid code exchange or token refresh rejection, restart the authorization command. Valid identity alone does not grant ChatGPT-plan usage; the direct-use permission is required. Errors contain fixed codes, never upstream token bodies.

For independent model/effort settings and reusable live vision/Telegram ID commands, see [operational diagnostics](diagnostics.md). These diagnostics work from a temporary local checkout or Cloud Shell. The owner's already-authorized profile can be reused.

## Responses constraints enforced

Requests target `https://api.openai.com/v1/responses` with OAuth Bearer authentication, `store:false`, `stream:true`, instructions, configured `reasoning.effort`, and an input array of text plus inline images. No model default, backend-api endpoint, API key, system-role message, server conversation state, temperature, max-output-token field, max-tool-calls field, or file upload API is used by vision. Textual verification additionally requests `web_search` with low context, subject to model/account policy; see [bounded geography](geography.md). Search enforces a 45-second deadline and refuses a second search operation or oversized stream on the client, because SIWC rejects `max_output_tokens` and `max_tool_calls`. Recognition JSON is validated locally. A stream succeeds only on `response.completed`; partial deltas, failed/incomplete events, missing completion and malformed results fail. Opt-in Gemini fallback processes the same images only when the primary Responses request returns HTTP 502, 503 or 504. The outage is explicitly classified and its use is attributed in the discovery. Other HTTP statuses (including 401/403, 429 and ambiguous 500), OAuth/refresh failures, invalid models/catalogs, malformed outputs/schema failures, incomplete/failed streams, programming errors and unclassified network/timeouts fail closed without Gemini. Primary failures are visible via fixed safe diagnostic codes; no upstream bodies or model content appear in those diagnostics. Missing primary credentials fail startup instead of making Gemini the implicit primary.

## Serverless session ownership

Follow the [owner-only import and reauthorization procedure](../infra/README.md#one-time-ids-secrets-and-siwc-import). The durable record in `OPENAI_SIWC_SESSION` includes issued client ID, subject, access/refresh/ID tokens, scopes and expiry. Runtime reads latest directly and adds new versions only to that secret. Credentials never enter Firestore or function environment parameters. `OPENAI_HOST_ID` is a stable generated UUID, independent of ephemeral files or account identifiers.

Suspend and drain webhook requests before replacing the session or using its local copy. Serverless must be its sole refresh owner after import. Tokens expire even when no requests arrive; rolling refresh lifetime is roughly 30 days, so long inactivity can require owner reauthorization. No scheduler keeps the service warm or refreshes idle sessions. Local profile files remain `0600` in a `0700` directory for OAuth/development only.

To disconnect, suspend webhook processing and revoke the app in ChatGPT Settings; remove private local copies and manage serverless secret versions through owner operations. A revocation UI is not implemented. Review plan usage and app access in ChatGPT Settings → Usage.

The existing imported production session and OPENAI_HOST_ID remain valid for this vertical slice; do not re-import or start a second local refresh owner merely to add verification. Search and vision share the same durable session/version checkpoint and refresh lease. No live inference or credential payload access was performed by development checks.
