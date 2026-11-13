import { readJson, DependencyError } from "./http.ts";
export class LineIdentity {
  readonly channel: string;
  readonly fetcher: typeof fetch;
  readonly now: () => Date;
  constructor(
    channel: string,
    fetcher: typeof fetch = fetch,
    now = () => new Date(),
  ) {
    if (!/^\d{1,32}$/.test(channel))
      throw new Error("invalid_line_login_channel");
    this.channel = channel;
    this.fetcher = fetcher;
    this.now = now;
  }
  async verify(token: string): Promise<string> {
    if (!token || token.length > 8192 || /[\s\x00-\x1f]/.test(token))
      throw new Error("content_forbidden");
    try {
      const response = await this.fetcher(
        "https://api.line.me/oauth2/v2.1/verify",
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(2000),
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            id_token: token,
            client_id: this.channel,
          }),
        },
      );
      const claims = await readJson(response);
      if (
        claims.iss !== "https://access.line.me" ||
        claims.aud !== this.channel ||
        typeof claims.sub !== "string" ||
        !/^U[0-9a-f]{32}$/.test(claims.sub) ||
        !Number.isSafeInteger(claims.exp) ||
        Number(claims.exp) * 1000 <= this.now().getTime()
      )
        throw new Error("content_forbidden");
      return claims.sub;
    } catch (error) {
      if (
        (error instanceof DependencyError &&
          [400, 401, 403].includes(error.status)) ||
        (error instanceof Error && error.message === "content_forbidden")
      )
        throw new Error("content_forbidden");
      throw new Error("content_unavailable");
    }
  }
}
