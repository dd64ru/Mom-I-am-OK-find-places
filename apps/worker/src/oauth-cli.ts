import { createServer } from 'node:http';
import {
  FileSessions,
  OpenAiOAuth,
  acquireRuntimeLock,
} from '@places/providers';
import { loadOAuthConfig } from './config.js';
async function main() {
  const config = loadOAuthConfig();
  const release = await acquireRuntimeLock(config.directory);
  const oauth = new OpenAiOAuth(
    new FileSessions(config.directory, config.hostId),
    config.profile,
  );
  let pending: Awaited<ReturnType<OpenAiOAuth['begin']>>['pending'] | undefined;
  let resolveDone!: () => void;
  let rejectDone!: (e: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  // Listener starts before authorization. Only the exact loopback callback is processed.
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method !== 'GET' || url.pathname !== '/auth/callback' || !pending) {
      res.writeHead(404).end();
      return;
    }
    if (url.searchParams.get('state') !== pending.state) {
      res.writeHead(400).end('Invalid authorization state.');
      return;
    }
    void oauth
      .complete(pending, url.searchParams)
      .then(() => {
        res
          .writeHead(200, {
            'Content-Type': 'text/plain',
            'Cache-Control': 'no-store',
          })
          .end('Authorization saved. You can close this window.');
        resolveDone();
      })
      .catch(() => {
        res
          .writeHead(400, {
            'Content-Type': 'text/plain',
            'Cache-Control': 'no-store',
          })
          .end('Authorization failed. Restart the command.');
        rejectDone(new Error('oauth_failed'));
      });
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('callback_unavailable');
    const attempt = await oauth.begin(
      `http://127.0.0.1:${address.port}/auth/callback`,
    );
    pending = attempt.pending;
    // CLI uses account selection instead of printing retained ID-token/login hints.
    const browserUrl = new URL(attempt.url);
    browserUrl.searchParams.delete('id_token_hint');
    browserUrl.searchParams.delete('login_hint');
    process.stdout.write(
      `Continue with ChatGPT — open privately in this computer's browser:\n${browserUrl}\n`,
    );
    timer = setTimeout(
      () => rejectDone(new Error('oauth_timed_out')),
      10 * 60_000,
    );
    await done;
    console.info('Authorization saved in protected local storage.');
  } finally {
    if (timer) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await release();
  }
}
void main().catch(() => {
  console.error('oauth_failed:restart_authorization');
  process.exitCode = 1;
});
