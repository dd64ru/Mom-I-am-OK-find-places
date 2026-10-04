export async function checkedFetch(
  url: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(90_000),
  });
  // Never include URL (Telegram token), upstream body, or bearer token in an error.
  if (!response.ok) throw new Error(`upstream_http_${response.status}`);
  return response;
}
