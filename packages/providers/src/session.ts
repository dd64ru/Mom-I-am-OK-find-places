import { mkdir, open, readFile, rename, chmod, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
export const SessionSchema = z
  .object({
    clientId: z
      .string()
      .min(1)
      .refine((v) => v !== 'dynamic_agent_client'),
    subject: z.string().min(1),
    issuer: z.literal('https://auth.openai.com'),
    email: z.string().optional(),
    idToken: z.string().min(1),
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1),
    scopes: z.array(z.string()),
    expiresAt: z.number(),
  })
  .strict();
export type Session = z.infer<typeof SessionSchema>;
export interface SessionStore {
  hostId(): Promise<string>;
  load(profile: string): Promise<Session | undefined>;
  save(profile: string, session: Session): Promise<void>;
  serializeRefresh?<T>(operation: () => Promise<T>): Promise<T>;
  refreshPhase?(phase: 'reserved' | 'refreshing'): Promise<void>;
}
export class FileSessions {
  constructor(
    readonly directory: string,
    private readonly configuredHostId?: string,
  ) {
    if (configuredHostId && !/^urn:uuid:[a-f0-9-]{36}$/.test(configuredHostId))
      throw new Error('invalid_host_id');
  }
  private profilePath(profile: string) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(profile))
      throw new Error('invalid_profile');
    return join(this.directory, `${profile}.json`);
  }
  private async prepare() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('invalid_session_directory');
    await chmod(this.directory, 0o700);
  }
  private async atomic(path: string, data: unknown) {
    await this.prepare();
    const temp = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(data));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  }
  async hostId(): Promise<string> {
    if (this.configuredHostId) return this.configuredHostId;
    await this.prepare();
    const path = join(this.directory, 'host.json');
    try {
      const f = await open(path, 'wx', 0o600);
      try {
        await f.writeFile(JSON.stringify({ id: `urn:uuid:${randomUUID()}` }));
        await f.sync();
      } finally {
        await f.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const value = JSON.parse(await readFile(path, 'utf8'));
    return z
      .string()
      .regex(/^urn:uuid:[a-f0-9-]{36}$/)
      .parse(value.id);
  }
  async load(profile: string): Promise<Session | undefined> {
    try {
      return SessionSchema.parse(
        JSON.parse(await readFile(this.profilePath(profile), 'utf8')),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  async save(profile: string, session: Session) {
    await this.atomic(this.profilePath(profile), SessionSchema.parse(session));
  }
  // VM import preserves its own host.json. A profile has one process owner (worker or CLI).
}
