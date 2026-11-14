import { ServiceClient } from "./http.ts";
export interface ReplyAction {
  label: string;
  data: string;
}
export class LineClient {
  readonly http: ServiceClient;
  constructor(token: string, fetcher: typeof fetch = fetch) {
    if (!token || token.length > 4096 || /[\s\x00-\x1f]/.test(token))
      throw new Error("invalid_line_credential");
    this.http = new ServiceClient(
      "https://api.line.me",
      { Authorization: `Bearer ${token}` },
      fetcher,
    );
  }
  async reply(
    token: string,
    text: string,
    actions?: ReplyAction[],
  ): Promise<void> {
    if (
      !token ||
      token.length > 512 ||
      !text.trim() ||
      text.length > 5000 ||
      (actions &&
        (actions.length > 13 ||
          actions.some(
            (a) =>
              !a.label || a.label.length > 20 || !a.data || a.data.length > 300,
          )))
    )
      throw new Error("invalid_reply");
    await this.http.json("/v2/bot/message/reply", "POST", {
      replyToken: token,
      messages: [
        {
          type: "text",
          text,
          ...(actions?.length
            ? {
                quickReply: {
                  items: actions.map((a) => ({
                    type: "action",
                    action: { type: "postback", label: a.label, data: a.data },
                  })),
                },
              }
            : {}),
        },
      ],
    });
  }
  async groupName(group: string): Promise<string> {
    if (!/^C[0-9a-f]{32}$/.test(group)) throw Error("invalid_line_identity");
    const r = await this.http.json(`/v2/bot/group/${group}/summary`, "GET");
    if (
      r.groupId !== group ||
      typeof r.groupName !== "string" ||
      !r.groupName ||
      r.groupName.length > 200 ||
      /[\x00-\x1f]/.test(r.groupName)
    )
      throw Error("dependency_unavailable");
    return r.groupName;
  }
  async member(group: string, user: string): Promise<boolean> {
    if (!/^C[0-9a-f]{32}$/.test(group) || !/^U[0-9a-f]{32}$/.test(user))
      throw new Error("invalid_line_identity");
    const result = await this.http.json(
      `/v2/bot/group/${group}/member/${user}`,
      "GET",
    );
    return result.userId === user;
  }
  async linkToken(user: string): Promise<string> {
    if (!/^U[0-9a-f]{32}$/.test(user)) throw new Error("invalid_line_identity");
    const result = await this.http.json(
      `/v2/bot/user/${user}/linkToken`,
      "POST",
    );
    if (
      typeof result.linkToken !== "string" ||
      !/^[A-Za-z0-9_-]{16,512}$/.test(result.linkToken)
    )
      throw new Error("dependency_unavailable");
    return result.linkToken;
  }
}
