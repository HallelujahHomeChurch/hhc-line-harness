import { fetch as proxyFetch, ProxyAgent } from "undici";

export function readOpenAiProxyUrl(
  value: string | undefined,
): string | undefined {
  if (!value?.trim()) return;
  try {
    const url = new URL(value.trim());
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new Error("invalid_openai_proxy_origin");
  }
}

export function createOpenAiTransport(
  proxyUrl: string | undefined,
  directFetch: typeof fetch = fetch,
) {
  const origin = readOpenAiProxyUrl(proxyUrl);
  if (!origin) return { fetch: directFetch, close: async () => {} };
  const dispatcher = new ProxyAgent({
    uri: origin,
    connections: 4,
    connectTimeout: 5000,
    headersTimeout: 40000,
    bodyTimeout: 40000,
  });
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== "https://api.openai.com" || url.username || url.password)
      throw new Error("openai_proxy_destination_denied");
    // The provider credential must never follow a redirect or escape the tunnel.
    return proxyFetch(
      input as Parameters<typeof proxyFetch>[0],
      {
        ...init,
        redirect: "error",
        dispatcher,
      } as Parameters<typeof proxyFetch>[1],
    ) as unknown as Promise<Response>;
  };
  return { fetch: fetcher, close: () => dispatcher.destroy() };
}
