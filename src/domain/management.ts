import { isAssetId } from "./asset-id.ts";
import { createHash, randomBytes } from "node:crypto";
import type { Store, InteractionFence } from "../persistence/store.ts";
import type { AdminAuthority, Registration } from "./registration.ts";
const uuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    s,
  );
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export class Management {
  readonly store: Store;
  readonly registration: Registration;
  readonly ports: {
    authority: (userId: string) => Promise<AdminAuthority>;
    collections?: (cursor: string) => Promise<{
      collections: { id: string; name: string }[];
      cursor?: string;
      hasMore: boolean;
    }>;
    revokeReader?: (
      collection: string,
      acl: string,
      revision: number,
      operation: string,
      actor: string,
    ) => Promise<void>;
    subjects?: (
      actor: string,
      type: "user" | "role",
      query: string,
      page: number,
    ) => Promise<{
      subjects: { id: string; type: "user" | "role"; label: string }[];
      page: number;
      hasMore: boolean;
    }>;
    createCollection?: (
      id: string,
      name: string,
      actor: string,
    ) => Promise<{ id: string; name: string }>;
  };
  constructor(
    store: Store,
    registration: Registration,
    ports: Management["ports"],
  ) {
    this.store = store;
    this.registration = registration;
    this.ports = ports;
  }
  async admin(actor: string) {
    if (!uuid(actor)) throw Error("admin_required");
    const a = await this.ports.authority(actor);
    if (
      !a.allowed ||
      a.actorUserId !== actor ||
      !Number.isSafeInteger(a.adminAuthorizationRevision) ||
      Number(a.adminAuthorizationRevision) <= 0
    )
      throw Error("admin_required");
    return a;
  }
  async collections(actor: string, cursor = "") {
    await this.admin(actor);
    if (cursor.length > 1024 || !this.ports.collections)
      throw Error("invalid_management_request");
    return this.ports.collections(cursor);
  }
  async subjects(
    actor: string,
    type: "user" | "role",
    query: string,
    page: number,
  ) {
    await this.admin(actor);
    if (!this.ports.subjects) throw Error("management_unavailable");
    return this.ports.subjects(actor, type, query, page);
  }
  async createCollection(actor: string, id: string, name: string) {
    await this.admin(actor);
    if (
      !uuid(id) ||
      typeof name !== "string" ||
      !name.trim() ||
      Buffer.byteLength(name) > 120 ||
      /[\x00-\x1f]/.test(name) ||
      !this.ports.createCollection
    )
      throw Error("invalid_management_request");
    const row = await this.store.transaction(async (c) => {
      const r = (await c.query("SELECT mode FROM runtime_state FOR SHARE"))
        .rows[0];
      if (r?.mode !== "open") throw Error("management_changed");
      await c.query(
        "INSERT INTO collection_creations(id,actor_user_id,name,created_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [id, actor, name.trim(), this.store.now()],
      );
      return (
        await c.query("SELECT * FROM collection_creations WHERE id=$1", [id])
      ).rows[0];
    });
    if (row.actor_user_id !== actor || row.name !== name.trim())
      throw Error("management_changed");
    const result = await this.ports.createCollection(id, row.name, actor);
    if (row.collection_id && row.collection_id !== result.id)
      throw Error("management_changed");
    await this.store.pool.query(
      "UPDATE collection_creations SET collection_id=$2 WHERE id=$1",
      [id, result.id],
    );
    return result;
  }
  async groups(actor: string, cursor = "", limit = 100) {
    await this.admin(actor);
    if (
      (cursor && !uuid(cursor)) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw Error("invalid_management_request");
    const r = await this.store.pool.query(
      `SELECT g.id,g.display_name,g.state,g.revision,g.sharing_enabled,g.collection_id,
   count(s.id)::int AS source_count,count(s.id) FILTER(WHERE s.state='failed')::int AS failed_count
   FROM (SELECT * FROM groups WHERE channel_id=$1 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4) g LEFT JOIN sources s ON s.group_id=g.id AND s.state NOT IN ('revoked','expired') AND s.expires_at>$2
   WHERE g.channel_id=$1 GROUP BY g.id,g.display_name,g.state,g.revision,g.sharing_enabled,g.collection_id ORDER BY g.id`,
      [this.store.channelId, this.store.now(), cursor || null, limit],
    );
    return r.rows;
  }
  async group(actor: string, id: string) {
    await this.admin(actor);
    if (!uuid(id)) throw Error("invalid_management_request");
    const g = (
      await this.store.pool.query(
        `SELECT g.id,g.display_name,g.state,g.revision,
          (SELECT count(*)::int FROM sources s WHERE s.group_id=g.id AND s.state NOT IN ('revoked','expired') AND s.expires_at>$3) AS source_count,
          (SELECT count(*)::int FROM sources s WHERE s.group_id=g.id AND s.state='failed' AND s.expires_at>$3) AS failed_count
          FROM groups g WHERE g.channel_id=$1 AND g.id=$2`,
        [this.store.channelId, id, this.store.now()],
      )
    ).rows[0];
    if (!g) throw Error("management_changed");
    return g;
  }
  async setup(actor: string, id: string) {
    await this.admin(actor);
    if (!uuid(id)) throw Error("setup_expired_or_changed");
    const row = (
      await this.store.pool.query(
        `SELECT i.line_actor_id FROM setup_intents i JOIN groups g ON g.id=i.group_id WHERE i.id=$1 AND g.channel_id=$2`,
        [id, this.store.channelId],
      )
    ).rows[0];
    if (!row) throw Error("setup_expired_or_changed");
    const intent = await this.registration.read(id, row.line_actor_id);
    const a = await this.registration.ports.authority(row.line_actor_id);
    if (!a.bound)
      return {
        id,
        state: "binding_required",
        expiresAt: intent.expires_at.toISOString(),
      };
    if (!a.allowed || a.actorUserId !== actor) throw Error("admin_required");
    if (
      intent.account_actor_id &&
      (intent.account_actor_id !== actor ||
        intent.account_binding_generation !== String(a.bindingGeneration) ||
        intent.admin_authorization_revision !==
          String(a.adminAuthorizationRevision))
    )
      throw Error("setup_expired_or_changed");
    return {
      id,
      state: intent.state,
      expiresAt: intent.expires_at.toISOString(),
      revision: Number(intent.revision),
      sharing: intent.sharing_enabled,
      collectionId: intent.collection_id,
      audience: intent.audience ?? [],
      addReader: intent.add_reader,
      groupId: intent.group_id,
    };
  }
  async configure(
    actor: string,
    id: string,
    config: {
      sharing: boolean;
      collectionId?: string;
      addReader?: { type: "user" | "role"; id: string };
      expectedRevision: number;
    },
  ) {
    if (
      !Number.isSafeInteger(config.expectedRevision) ||
      config.expectedRevision <= 0
    )
      throw Error("invalid_management_request");
    const context = await this.setup(actor, id);
    if (context.state === "binding_required")
      throw Error("admin_binding_required");
    const row = (
      await this.store.pool.query(
        "SELECT line_actor_id FROM setup_intents WHERE id=$1",
        [id],
      )
    ).rows[0];
    await this.registration.configure(
      id,
      row.line_actor_id,
      config,
      actor,
      config.expectedRevision,
    );
    return this.setup(actor, id);
  }
  async readers(actor: string, groupId: string) {
    await this.admin(actor);
    if (!uuid(groupId)) throw Error("invalid_management_request");
    const g = (
      await this.store.pool.query(
        "SELECT * FROM groups WHERE id=$1 AND channel_id=$2",
        [groupId, this.store.channelId],
      )
    ).rows[0];
    if (!g?.collection_id || ["deleting", "deleted"].includes(g.state))
      throw Error("management_changed");
    const collection = await this.registration.approval(g.collection_id);
    if (String(collection.bindingGeneration) !== g.binding_generation)
      throw Error("management_changed");
    return { group: g, collection };
  }
  async previewRevoke(
    actor: string,
    groupId: string,
    aclId: string,
    expectedRevision: number,
  ) {
    if (!isAssetId(aclId)) throw Error("invalid_management_request");
    const { collection } = await this.readers(actor, groupId);
    const reader = collection.readers?.find((r) => r.id === aclId);
    if (!reader) throw Error("management_changed");
    return this.preview(actor, groupId, "acl_revoke", expectedRevision, {
      collectionId: collection.id,
      aclId,
      subject: `${reader.type}:${reader.subjectId}`,
      aclRevision: collection.aclRevision,
      binding: collection.bindingGeneration,
      audience: collection.audience.filter(
        (a) => a !== `${reader.type}:${reader.subjectId}`,
      ),
    });
  }
  async preview(
    actor: string,
    groupId: string,
    action: "pause" | "delete" | "acl_revoke",
    expectedRevision: number,
    revoke?: {
      collectionId: string;
      aclId: string;
      subject: string;
      aclRevision: number;
      binding: number;
      audience: string[];
    },
    fence?: InteractionFence,
  ) {
    const a = await this.admin(actor);
    if (
      !uuid(groupId) ||
      !["pause", "delete", "acl_revoke"].includes(action) ||
      (action === "acl_revoke" && !revoke) ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision <= 0
    )
      throw Error("invalid_management_request");
    const token = randomBytes(32).toString("base64url");
    return this.store.transaction(async (c) => {
      const runtime = (await c.query("SELECT * FROM runtime_state FOR SHARE"))
        .rows[0];
      const g = (
        await c.query(
          "SELECT * FROM groups WHERE id=$1 AND channel_id=$2 FOR UPDATE",
          [groupId, this.store.channelId],
        )
      ).rows[0];
      if (
        runtime?.mode !== "open" ||
        !g ||
        g.revision !== String(expectedRevision) ||
        ["deleting", "deleted"].includes(g.state)
      )
        throw Error("management_changed");
      await this.store.requireInteraction(c, fence);
      if (
        revoke &&
        (g.collection_id !== revoke.collectionId ||
          g.binding_generation !== String(revoke.binding))
      )
        throw Error("management_changed");
      const op = (
        await c.query(
          `INSERT INTO management_operations(group_id,actor_user_id,admin_authorization_revision,account_binding_generation,runtime_generation,group_revision,action,confirmation_hash,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,expires_at`,
          [
            g.id,
            actor,
            a.adminAuthorizationRevision,
            a.bindingGeneration ?? null,
            runtime.generation,
            g.revision,
            action,
            digest(token),
            new Date(this.store.now().getTime() + 5 * 60_000),
          ],
        )
      ).rows[0];
      if (revoke)
        await c.query(
          "UPDATE management_operations SET collection_id=$2,acl_id=$3,acl_revision=$4,binding_generation=$5,previous_sharing=$6,audience=$7 WHERE id=$1",
          [
            op.id,
            revoke.collectionId,
            revoke.aclId,
            revoke.aclRevision,
            revoke.binding,
            g.sharing_enabled,
            JSON.stringify(revoke.audience),
          ],
        );
      return {
        id: op.id as string,
        token,
        expiresAt: (op.expires_at as Date).toISOString(),
        action,
        groupId,
        revision: expectedRevision,
        text:
          `${g.display_name}：` +
          (action === "acl_revoke"
            ? `撤銷讀者 ${revoke?.subject} 後立即失去資料集存取權；處理結果未確認前暫停全部分享。已匯出的副本無法收回。`
            : action === "pause"
              ? "暫停後立即停止收錄與讀取；90 天期限照算，恢復須回原群組確認，不回補。"
              : "刪除後立即停止收錄與讀取，清除群組資料與同步項目；無法復原。"),
      };
    });
  }
  async confirm(
    actor: string,
    id: string,
    token: string,
    fence?: InteractionFence,
  ) {
    const a = await this.admin(actor);
    if (!uuid(id) || !/^[A-Za-z0-9_-]{43}$/.test(token))
      throw Error("invalid_management_request");
    const original = (
      await this.store.pool.query(
        "SELECT group_id FROM management_operations WHERE id=$1 AND actor_user_id=$2",
        [id, actor],
      )
    ).rows[0];
    if (!original) throw Error("management_changed");
    const mutation = await this.store.transaction(async (c) => {
      const runtime = (await c.query("SELECT * FROM runtime_state FOR SHARE"))
        .rows[0];
      const g = (
        await c.query(
          "SELECT * FROM groups WHERE id=$1 AND channel_id=$2 FOR UPDATE",
          [original.group_id, this.store.channelId],
        )
      ).rows[0];
      const p = (
        await c.query(
          "SELECT * FROM management_operations WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (
        !g ||
        runtime?.mode !== "open" ||
        p.runtime_generation !== runtime.generation ||
        p.actor_user_id !== actor ||
        p.confirmation_hash !== digest(token) ||
        p.admin_authorization_revision !==
          String(a.adminAuthorizationRevision) ||
        (p.account_binding_generation ?? null) !==
          (a.bindingGeneration ? String(a.bindingGeneration) : null)
      )
        throw Error("management_changed");
      await this.store.requireInteraction(c, fence);
      if (p.state === "completed") return;
      if (p.action === "acl_revoke" && p.state === "applying") {
        if (
          g.revision !== String(BigInt(p.group_revision) + 1n) ||
          g.collection_id !== p.collection_id ||
          g.sharing_enabled ||
          g.binding_generation !== p.binding_generation
        )
          throw Error("management_changed");
        return p;
      }
      if (p.expires_at <= this.store.now() || p.group_revision !== g.revision)
        throw Error("management_changed");
      if (p.action === "acl_revoke") {
        if (
          !this.ports.revokeReader ||
          g.collection_id !== p.collection_id ||
          g.binding_generation !== p.binding_generation
        )
          throw Error("management_changed");
        await c.query(
          "UPDATE groups SET sharing_enabled=false,revision=revision+1 WHERE id=$1",
          [g.id],
        );
        await c.query(
          "UPDATE management_operations SET state='applying' WHERE id=$1",
          [id],
        );
        await c.query(
          "INSERT INTO audit_outbox(action,actor_user_id,target_id,target_revision,occurred_at) VALUES('line.group.acl_revoke_requested',$1,$2,$3,$4)",
          [actor, g.id, String(BigInt(g.revision) + 1n), this.store.now()],
        );
        return p;
      }
      await c.query(
        "UPDATE groups SET state=$2,revision=revision+1 WHERE id=$1",
        [g.id, p.action === "pause" ? "paused" : "deleting"],
      );
      await c.query(
        "UPDATE deliveries SET state='cancelled',token_ciphertext=NULL,body=NULL,actions=NULL WHERE group_id=$1 AND state='pending'",
        [g.id],
      );
      if (p.action === "pause")
        await c.query(
          "UPDATE jobs SET state='held',fence=fence+1 FROM sources s WHERE jobs.source_id=s.id AND s.group_id=$1 AND jobs.kind NOT IN ('cleanup','unpublish') AND jobs.state IN ('queued','retry_wait','leased')",
          [g.id],
        );
      await c.query(
        "UPDATE management_operations SET state='completed' WHERE id=$1",
        [id],
      );
      await c.query(
        "INSERT INTO audit_outbox(action,actor_user_id,target_id,target_revision,occurred_at) VALUES($1,$2,$3,$4,$5)",
        [
          `line.group.${p.action}`,
          actor,
          g.id,
          String(BigInt(g.revision) + 1n),
          this.store.now(),
        ],
      );
    });
    if (!mutation) return;
    await this.ports.revokeReader!(
      mutation.collection_id,
      mutation.acl_id,
      Number(mutation.acl_revision),
      digest(`${id}:revoke`),
      actor,
    );
    const collection = await this.registration.approval(mutation.collection_id);
    const fresh = await this.admin(actor);
    if (
      String(fresh.adminAuthorizationRevision) !==
        mutation.admin_authorization_revision ||
      (fresh.bindingGeneration ? String(fresh.bindingGeneration) : null) !==
        mutation.account_binding_generation ||
      collection.aclRevision !== Number(mutation.acl_revision) + 1 ||
      String(collection.bindingGeneration) !== mutation.binding_generation ||
      JSON.stringify(collection.audience) !==
        JSON.stringify([...mutation.audience].sort())
    )
      throw Error("management_changed");
    await this.store.transaction(async (c) => {
      const runtime = (await c.query("SELECT * FROM runtime_state FOR SHARE"))
        .rows[0];
      const g = (
        await c.query("SELECT * FROM groups WHERE id=$1 FOR UPDATE", [
          mutation.group_id,
        ])
      ).rows[0];
      const p = (
        await c.query(
          "SELECT * FROM management_operations WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      await this.store.requireInteraction(c, fence);
      if (p.state === "completed") return;
      if (
        runtime?.mode !== "open" ||
        runtime.generation !== mutation.runtime_generation ||
        p.state !== "applying" ||
        g.revision !== String(BigInt(mutation.group_revision) + 1n) ||
        g.collection_id !== mutation.collection_id ||
        g.binding_generation !== mutation.binding_generation ||
        g.sharing_enabled
      )
        throw Error("management_changed");
      await c.query(
        "UPDATE groups SET sharing_enabled=$2,acl_revision=$3,revision=revision+1 WHERE id=$1",
        [g.id, mutation.previous_sharing, collection.aclRevision],
      );
      await c.query(
        "UPDATE publications SET acl_revision=$3 WHERE source_id IN (SELECT id FROM sources WHERE group_id=$1 AND expires_at>$4 AND state NOT IN ('revoked','expired')) AND collection_id=$2 AND binding_generation=$5 AND state<>'revoked'",
        [
          g.id,
          collection.id,
          collection.aclRevision,
          this.store.now(),
          collection.bindingGeneration,
        ],
      );
      await c.query(
        "UPDATE sources SET publication_acl_revision=$3 WHERE group_id=$1 AND publication_collection_id=$2 AND publication_binding_generation=$4 AND expires_at>$5 AND state NOT IN ('revoked','expired')",
        [
          g.id,
          collection.id,
          collection.aclRevision,
          collection.bindingGeneration,
          this.store.now(),
        ],
      );
      await c.query(
        "UPDATE management_operations SET state='completed' WHERE id=$1",
        [id],
      );
      await c.query(
        "INSERT INTO audit_outbox(action,actor_user_id,target_id,target_revision,occurred_at) VALUES('line.group.acl_revoke',$1,$2,$3,$4)",
        [actor, g.id, String(BigInt(g.revision) + 1n), this.store.now()],
      );
    });
  }
}
