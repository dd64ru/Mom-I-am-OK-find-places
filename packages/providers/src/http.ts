export class UpstreamHttpError extends Error {
  constructor(readonly status: number) {
    super(`upstream_http_${status}`);
    this.name = 'UpstreamHttpError';
  }
}
export async function checkedFetch(
  url: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(90_000),
  });
  // Never include URL (Telegram token), upstream body, or bearer token in an error.
  if (!response.ok) throw new UpstreamHttpError(response.status);
  return response;
}
