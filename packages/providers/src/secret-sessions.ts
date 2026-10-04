import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { SessionSchema, type Session, type SessionStore } from './session.js';
import { RefreshLease } from './lease.js';
export interface SessionSecrets {
  read(version?: string): Promise<Uint8Array>;
  add(payload: Uint8Array): Promise<string>;
}
export function encodeSession(value: Session): Uint8Array {
  try {
    return Buffer.from(JSON.stringify(SessionSchema.parse(value)));
  } catch {
    throw new Error('openai_session_invalid');
  }
}
export function decodeSession(payload: Uint8Array): Session {
  try {
    if (payload.byteLength > 64 * 1024) throw new Error();
    return SessionSchema.parse(
      JSON.parse(Buffer.from(payload).toString('utf8')),
    );
  } catch {
    throw new Error('openai_session_invalid');
  }
}
export function googleSessionSecrets(
  project: string,
  client = new SecretManagerServiceClient(),
): SessionSecrets {
  const parent = `projects/${project}/secrets/OPENAI_SIWC_SESSION`;
  return {
    async read(versionName?: string) {
      try {
        const number = versionName?.match(
          /^projects\/[a-z0-9-]+\/secrets\/OPENAI_SIWC_SESSION\/versions\/([0-9]+)$/,
        )?.[1];
        if (versionName && !number) throw new Error();
        const [version] = await client.accessSecretVersion(
          {
            name: `${parent}/versions/${number ?? 'latest'}`,
          },
          { timeout: 20_000 },
        );
        if (!version.payload?.data) throw new Error();
        return typeof version.payload.data === 'string'
          ? Buffer.from(version.payload.data, 'base64')
          : Buffer.from(version.payload.data);
      } catch {
        throw new Error('openai_session_unavailable');
      }
    },
    async add(data) {
      try {
        const [version] = await client.addSecretVersion(
          { parent, payload: { data } },
          { timeout: 20_000 },
        );
        if (
          !version.name ||
          !/^projects\/[a-z0-9-]+\/secrets\/OPENAI_SIWC_SESSION\/versions\/[0-9]+$/.test(
            version.name,
          )
        )
          throw new Error();
        return version.name;
      } catch {
        throw new Error(
          'openai_session_save_failed:reauthorization_may_be_required',
        );
      }
    },
  };
}
export class SecretSessions implements SessionStore {
  constructor(
    private readonly secrets: SessionSecrets,
    private readonly host: string,
    private readonly lease: RefreshLease,
  ) {
    if (!/^urn:uuid:[a-f0-9-]{36}$/.test(host))
      throw new Error('openai_host_invalid');
  }
  async hostId() {
    return this.host;
  }
  async load(profile: string) {
    if (profile !== 'owner') throw new Error('openai_profile_invalid');
    let payload: Uint8Array;
    try {
      payload = await this.secrets.read(await this.lease.version());
    } catch {
      throw new Error('openai_session_unavailable');
    }
    return decodeSession(payload);
  }
  async save(profile: string, value: Session) {
    if (profile !== 'owner') throw new Error('openai_profile_invalid');
    await this.lease.phase('refreshing'); // fence writes against expired/replaced ownership
    const payload = encodeSession(value);
    try {
      const version = await this.secrets.add(payload);
      if (!version) throw new Error();
      await this.lease.checkpoint(version);
    } catch {
      throw new Error(
        'openai_session_save_failed:reauthorization_may_be_required',
      );
    }
  }
  serializeRefresh<T>(operation: () => Promise<T>) {
    return this.lease.run(operation);
  }
  refreshPhase(phase: 'reserved' | 'refreshing') {
    return this.lease.phase(phase);
  }
}
