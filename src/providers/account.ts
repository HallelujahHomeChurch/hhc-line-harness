import { object } from "../domain/events.ts";
import { ServiceClient } from "./http.ts";
import type { AdminAuthority } from "../domain/registration.ts";
export class AccountClient {
  readonly http: ServiceClient;
  readonly profile: string;
  readonly channel: string;
  constructor(
    origin: string,
    token: string,
    profile: string,
    channel: string,
    fetcher: typeof fetch = fetch,
  ) {
    if (
      !/^[0-9a-f]{64}$/.test(token) ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(profile) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(channel)
    )
      throw new Error("invalid_account_config");
    this.http = new ServiceClient(
      origin,
      {
        "X-HHC-Account-Service-Caller": "hhc-line-harness",
        "X-HHC-Account-Service-Token": token,
      },
      fetcher,
    );
    this.profile = profile;
    this.channel = channel;
  }
  async authority(lineUserId: string): Promise<AdminAuthority> {
    return this.authorize({ lineUserId });
  }
  async subjectAuthority(userId: string): Promise<AdminAuthority> {
    return this.authorize({ userId });
  }
  private async authorize(
    subject: { lineUserId: string } | { userId: string },
  ): Promise<AdminAuthority> {
    const r = await this.http.json(
      "/priv/account/v1/line-harness/admin-authority",
      "POST",
      subject,
    );
    if (
      r.version !== 1 ||
      typeof r.allowed !== "boolean" ||
      typeof r.bound !== "boolean"
    )
      throw new Error("dependency_unavailable");
    if (!r.allowed) return { allowed: false, bound: r.bound };
    if (
      typeof r.actorUserId !== "string" ||
      !/^[0-9a-f-]{36}$/.test(r.actorUserId) ||
      !Number.isSafeInteger(r.adminAuthorizationRevision) ||
      Number(r.adminAuthorizationRevision) <= 0 ||
      (r.bound &&
        (!Number.isSafeInteger(r.bindingGeneration) ||
          Number(r.bindingGeneration) <= 0))
    )
      throw new Error("dependency_unavailable");
    return {
      allowed: true,
      bound: r.bound,
      actorUserId: r.actorUserId,
      adminAuthorizationRevision: Number(r.adminAuthorizationRevision),
      ...(r.bound ? { bindingGeneration: Number(r.bindingGeneration) } : {}),
    };
  }
  async subjects(
    actor: string,
    type: "user" | "role",
    query: string,
    page = 1,
  ) {
    if (
      !/^[0-9a-f-]{36}$/.test(actor) ||
      !["user", "role"].includes(type) ||
      query.length > 120 ||
      /[\x00-\x1f]/.test(query) ||
      !Number.isSafeInteger(page) ||
      page < 1 ||
      page > 1000
    )
      throw Error("invalid_management_request");
    const r = await this.http.json(
      "/priv/account/v1/line-harness/acl-subjects/search",
      "POST",
      { userId: actor, subjectType: type, query, page, perPage: 20 },
    );
    if (
      !Array.isArray(r.subjects) ||
      r.subjects.length > 20 ||
      r.page !== page ||
      r.perPage !== 20 ||
      typeof r.hasMore !== "boolean"
    )
      throw Error("dependency_unavailable");
    const subjects = r.subjects.map((raw: unknown) => {
      const v = object(raw);
      if (
        v.type !== type ||
        typeof v.id !== "string" ||
        !/^[0-9a-f-]{36}$/.test(v.id) ||
        typeof v.displayName !== "string" ||
        !v.displayName ||
        v.displayName.length > 200 ||
        /[\x00-\x1f]/.test(v.displayName)
      )
        throw Error("dependency_unavailable");
      return { id: v.id, type, label: v.displayName };
    });
    return { subjects, page, hasMore: r.hasMore };
  }
  async subject(actor: string, type: "user" | "role", id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw Error("invalid_management_request");
    const result = await this.subjects(actor, type, id);
    const found = result.subjects.find((s) => s.id === id);
    if (!found) throw Error("subject_unavailable");
    return found;
  }
  async binding(userId: string, linkToken: string): Promise<string> {
    const r = await this.http.json(
      "/priv/account/v1/line-harness/bindings",
      "POST",
      {
        expected_line_user_id: userId,
        profile_name: this.profile,
        channel_id: this.channel,
        line_account_name: "HHC 群組助理",
        line_link_token: linkToken,
      },
    );
    if (typeof r.binding_url !== "string" || r.binding_url.length > 2048)
      throw new Error("dependency_unavailable");
    const url = new URL(r.binding_url);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/line/bind" ||
      url.search ||
      !url.hash.startsWith("#token=")
    )
      throw new Error("dependency_unavailable");
    return url.toString();
  }
  async finalize(
    userId: string,
    nonce: string,
    result: "ok" | "failed",
    eventId: string,
  ): Promise<void> {
    await this.http.json(
      "/priv/account/v1/line-harness/bindings/finalize",
      "POST",
      {
        actual_line_user_id: userId,
        nonce,
        result,
        webhook_event_id: eventId,
        profile_name: this.profile,
        channel_id: this.channel,
      },
    );
  }
}
