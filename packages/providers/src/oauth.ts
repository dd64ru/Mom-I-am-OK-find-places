import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';
import { checkedFetch } from './http.js';
import { FileSessions, type Session } from './session.js';
const issuer = 'https://auth.openai.com';
const resource = 'https://api.openai.com/v1';
const tokenUrl = `${issuer}/api/accounts/oauth/token`;
const scopes =
  'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const TokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  id_token: z.string().optional(),
  expires_in: z.number().positive(),
  scope: z.string().optional(),
  token_type: z.string().refine((s) => s.toLowerCase() === 'bearer'),
});
export interface PendingAuthorization {
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  selected?: Session;
  createdAt: number;
  consumed: boolean;
}
const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
export class OpenAiOAuth {
  private renewal?: Promise<Session>;
  constructor(
    private readonly sessions: FileSessions,
    readonly profile: string,
  ) {}
  async begin(redirectUri: string) {
    const uri = new URL(redirectUri);
    if (
      uri.protocol !== 'http:' ||
      uri.hostname !== '127.0.0.1' ||
      uri.pathname !== '/auth/callback' ||
      uri.search ||
      uri.hash ||
      uri.username
    )
      throw new Error('invalid_loopback_callback');
    const selected = await this.sessions.load(this.profile);
    const random = () => randomBytes(32).toString('base64url');
    const pending: PendingAuthorization = {
      state: random(),
      nonce: random(),
      verifier: random(),
      redirectUri,
      selected,
      createdAt: Date.now(),
      consumed: false,
    };
    const url = new URL(`${issuer}/api/accounts/authorize`);
    url.search = new URLSearchParams({
      client_id: selected?.clientId ?? 'dynamic_agent_client',
      ext_agent_host_id: await this.sessions.hostId(),
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: scopes,
      resource,
      state: pending.state,
      nonce: pending.nonce,
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256')
        .update(pending.verifier)
        .digest('base64url'),
      ...(selected
        ? {
            id_token_hint: selected.idToken,
            ...(selected.email ? { login_hint: selected.email } : {}),
          }
        : { agent_name_hint: "Mom I'm OK Places" }),
    }).toString();
    return { url, pending };
  }
  async complete(
    pending: PendingAuthorization,
    params: URLSearchParams,
  ): Promise<void> {
    if (
      pending.consumed ||
      Date.now() - pending.createdAt > 10 * 60_000 ||
      params.get('state') !== pending.state
    )
      throw new Error('invalid_oauth_state');
    pending.consumed = true;
    if (params.has('error')) throw new Error('oauth_denied');
    const clientId = params.get('client_id') ?? pending.selected?.clientId;
    if (
      !clientId ||
      clientId === 'dynamic_agent_client' ||
      (pending.selected && clientId !== pending.selected.clientId)
    )
      throw new Error('invalid_issued_client');
    const code = params.get('code');
    if (!code) throw new Error('oauth_code_missing');
    const tokens = await this.exchange({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: pending.verifier,
      redirect_uri: pending.redirectUri,
      resource,
    });
    if (!tokens.id_token || !tokens.refresh_token || !tokens.scope)
      throw new Error('incomplete_oauth_grant');
    const { payload } = await jwtVerify(tokens.id_token, jwks, {
      issuer,
      audience: clientId,
    });
    if (
      !payload.sub ||
      !payload.exp ||
      payload.nonce !== pending.nonce ||
      (pending.selected && payload.sub !== pending.selected.subject)
    )
      throw new Error('invalid_oauth_identity');
    const granted = tokens.scope.split(/\s+/);
    this.checkPermission(granted);
    await this.sessions.save(this.profile, {
      clientId,
      subject: payload.sub,
      issuer,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      idToken: tokens.id_token,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      scopes: granted,
      expiresAt: Date.now() + tokens.expires_in * 1000,
    });
  }
  private checkPermission(granted: string[]) {
    if (
      !granted.includes('chatgpt.tokens.use.direct') ||
      !granted.includes('resource.invoke')
    )
      throw new Error('chatgpt_plan_permission_missing');
  }
  private async exchange(body: Record<string, string>) {
    const response = await checkedFetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    });
    return TokenSchema.parse(await response.json());
  }
  async accessToken(): Promise<string> {
    const session = await this.sessions.load(this.profile);
    if (!session) throw new Error('openai_authorization_required');
    this.checkPermission(session.scopes);
    if (session.expiresAt > Date.now() + 60_000) return session.accessToken;
    // Coalesce refreshes in this process; the worker holds an exclusive file lock for its lifetime.
    this.renewal ??= this.refresh(session).finally(() => {
      this.renewal = undefined;
    });
    return (await this.renewal).accessToken;
  }
  private async refresh(session: Session): Promise<Session> {
    const tokens = await this.exchange({
      grant_type: 'refresh_token',
      client_id: session.clientId,
      refresh_token: session.refreshToken,
      resource,
    });
    const next: Session = {
      ...session,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? session.refreshToken,
      expiresAt: Date.now() + tokens.expires_in * 1000,
      scopes: tokens.scope ? tokens.scope.split(/\s+/) : session.scopes,
    };
    // A refreshed ID token has no new authorization nonce. Validate identity before retaining it.
    if (tokens.id_token) {
      const { payload } = await jwtVerify(tokens.id_token, jwks, {
        issuer,
        audience: session.clientId,
      });
      if (!payload.exp || payload.sub !== session.subject)
        throw new Error('invalid_refresh_identity');
      next.idToken = tokens.id_token;
    }
    this.checkPermission(next.scopes);
    await this.sessions.save(this.profile, next);
    return next;
  }
}
