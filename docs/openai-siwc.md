# OpenAI Sign in with ChatGPT

Official documentation inspected on 2026-10-04. This preview can change; revisit these references before deployment:

- [OSS registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Profiles, refresh and session security](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)
- [Current Responses restrictions](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [OIDC discovery](https://auth.openai.com/.well-known/openid-configuration)

## Implemented procedure

1. Copy `.env.example` to `.env`. Set `OPENAI_SESSION_DIR` to private persistent storage and choose `OPENAI_PROFILE=owner`. Worker settings can remain empty while authorizing. Use a different profile label for each additional account/workspace registration; do not repurpose an existing profile for another identity.
2. Run `npm run build`, then `npm run oauth` on the computer where the browser runs. The CLI obtains an exclusive runtime lock, persists a stable `urn:uuid:...` host ID, and starts an ephemeral-port listener on `127.0.0.1` before displaying the authorization URL. Open that URL privately. No real OAuth was run during repository bootstrap.
3. First registration uses `dynamic_agent_client`, the stable host ID, consistent app name, fresh state/nonce, S256 PKCE, exact loopback `/auth/callback`, resource `https://api.openai.com/v1`, and `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct` scopes.
4. The returned issued client ID, not `dynamic_agent_client`, is used to exchange the code without a client secret. State, expiry of the attempt and replay are checked. The ID token is verified against official JWKS for signature, issuer, audience, expiration and nonce. Its verified subject and issued client ID remain paired. Returning sign-in cannot replace the registration with a different client ID or subject.
5. Granted scopes authorize plan usage. The whole credential set is atomically written with `0600` files in a `0700` directory. Access, rotating refresh and ID tokens never enter Firestore. The CLI omits retained ID-token/login hints from its displayed URL to avoid printing tokens; returning login therefore uses the normal account selector. The OAuth boundary supports those hints for a future private browser-launch UI.
6. Run `npm run models`. It queries the selected account's `/v1/models`, preserves `visibility=list` server order and displays slug/name. Put an available image-capable slug in `OPENAI_MODEL`; image support still depends on model/account policy. The worker validates the configured model against the catalog once at startup, before composing fallback or starting Telegram polling. An unavailable model aborts startup with the fixed diagnostic `openai_model_unavailable`. Image batches do not query the catalog. Restart the worker after changing account or model configuration; runtime model/permission rejection fails the operation instead of switching providers.
7. The worker refreshes near expiry using the issued client ID, refresh token and resource, omitting scope. It atomically saves replacement credentials and serializes refreshes. Stop the worker before OAuth/model/vision CLI operations: the lifetime file lock prevents simultaneous owners, including separate processes.

An authorization attempt is single-use. After denied authorization, invalid code exchange or token refresh rejection, restart the authorization command. Valid identity alone does not grant ChatGPT-plan usage; the direct-use permission is required. Errors contain fixed codes, never upstream token bodies.

For independent model/effort settings and reusable live vision/Telegram ID commands, see [operational diagnostics](diagnostics.md). These diagnostics work from a temporary local checkout or the future VM. The owner's already-authorized profile can be reused.

## Responses constraints enforced

Requests target `https://api.openai.com/v1/responses` with OAuth Bearer authentication, `store:false`, `stream:true`, instructions, configured `reasoning.effort`, and an input array of text plus inline images. No model default, backend-api endpoint, API key, system-role message, server conversation state, temperature, max-output-token field, hosted tool, or file upload API is used. Recognition JSON is validated locally. A stream succeeds only on `response.completed`; partial deltas, failed/incomplete events, missing completion and malformed results fail. Opt-in Gemini fallback processes the same images only when the primary Responses request returns HTTP 502, 503 or 504. The outage is explicitly classified and its use is attributed in the discovery. Other HTTP statuses (including 401/403, 429 and ambiguous 500), OAuth/refresh failures, invalid models/catalogs, malformed outputs/schema failures, incomplete/failed streams, programming errors and unclassified network/timeouts fail closed without Gemini. Primary failures are visible via fixed safe diagnostic codes; no upstream bodies or model content appear in those diagnostics. Missing primary credentials fail startup instead of making Gemini the implicit primary.

## Persistent VM setup

Create the VM's own session directory and host ID first (for example call `new FileSessions(directory).hostId()` from the built providers module). Complete OAuth locally for the intended user/workspace, or reuse the owner's already-authorized selected profile. The laptop is a setup tool; the VM is the permanent runtime. Securely transfer only the selected profile's credential file over SSH to the VM's session directory with owner-only permissions; do not replace the VM's `host.json` with the laptop's ID. Let the VM own subsequent refreshes and stop the laptop process using that copied session. Reauthorization on that VM uses its own host ID. Official docs note that host-specific attribution/revocation for transferred sessions is not yet available.

Protect the directory outside the deployment checkout, restrict it to the runtime Unix user, and include it only in protected operational backups. A crash can leave `owner.lock`: verify the old process is stopped before removing that lock. Neither worker replicas nor multiple machines should refresh the same copied session.

Sign-out/revocation UI is not implemented. To disconnect now, stop the worker and disconnect the app in ChatGPT Settings, then remove the local profile credential file while retaining the host identity. A future sign-out command should use the discovered revocation endpoint with the refresh token, issued client ID and `token_type_hint=refresh_token`, and report unconfirmed remote revocation. Review plan usage and app access in ChatGPT Settings → Usage.
