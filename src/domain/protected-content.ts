import type { Store } from "../persistence/store.ts";
export interface ContentHeaders {
  range?: string;
  etag?: string;
  modifiedSince?: string;
}
interface Ports {
  identity: (token: string) => Promise<string>;
  member: (group: string, user: string) => Promise<boolean>;
  open: (
    assetId: string,
    method: "GET" | "HEAD",
    headers: ContentHeaders,
  ) => Promise<Response>;
}
export class ProtectedContent {
  readonly store: Store;
  readonly ports: Ports;
  constructor(store: Store, ports: Ports) {
    this.store = store;
    this.ports = ports;
  }
  async snapshot(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("content_forbidden");
    const row = (
      await this.store.pool.query(
        `SELECT s.*,g.line_group_id,g.state AS group_state,g.revision AS group_revision,r.mode AS runtime_mode
    FROM runtime_state r LEFT JOIN (sources s JOIN groups g ON g.id=s.group_id) ON s.id::text=$1 AND g.channel_id=$2`,
        [id, this.store.channelId],
      )
    ).rows[0];
    if (row?.runtime_mode !== "open") throw new Error("content_unavailable");
    if (!row.id) throw new Error("content_forbidden");
    return row;
  }
  available(row: Awaited<ReturnType<ProtectedContent["snapshot"]>>) {
    if (
      ["revoked", "expired"].includes(row.state) ||
      row.expires_at <= this.store.now() ||
      ["deleted", "deleting"].includes(row.group_state)
    )
      throw new Error("content_gone");
    if (row.group_state !== "active") throw new Error("content_paused");
    if (row.state !== "ready" || !row.asset_id || !row.asset_etag)
      throw new Error("content_unavailable");
  }
  async get(
    id: string,
    token: string,
    method: "GET" | "HEAD",
    headers: ContentHeaders,
  ): Promise<Response> {
    const user = await this.ports.identity(token);
    const first = await this.snapshot(id);
    if (!(await this.ports.member(first.line_group_id, user)))
      throw new Error("content_forbidden");
    const source = await this.snapshot(id);
    this.available(source);
    if (
      source.revision !== first.revision ||
      source.group_revision !== first.group_revision
    )
      throw new Error("content_unavailable");
    const response = await this.ports.open(source.asset_id, method, headers);
    try {
      const current = await this.snapshot(id);
      this.available(current);
      if (
        source.revision !== current.revision ||
        source.group_revision !== current.group_revision
      )
        throw new Error("content_unavailable");
      if (![200, 206, 304].includes(response.status))
        throw new Error(
          response.status === 410
            ? "content_gone"
            : response.status === 423
              ? "content_paused"
              : "content_unavailable",
        );
      return response;
    } catch (error) {
      await response.body?.cancel();
      throw error;
    }
  }
}
