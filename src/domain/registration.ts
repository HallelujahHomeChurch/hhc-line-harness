import { isAssetId } from "./asset-id.ts";
import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import type { Store, InteractionFence } from "../persistence/store.ts";
import { Deliveries } from "../reply/deliveries.ts";
export interface AdminAuthority {
  allowed: boolean;
  bound: boolean;
  actorUserId?: string;
  bindingGeneration?: number;
  adminAuthorizationRevision?: number;
}
export interface CollectionApproval {
  id: string;
  aclRevision: number;
  bindingGeneration: number;
  audience: string[];
  readers?: { id: string; type: "user" | "role"; subjectId: string }[];
}
export interface ReaderSubject {
  id: string;
  type: "user" | "role";
  label: string;
}
export interface RegistrationPorts {
  subject?: (
    actor: string,
    type: "user" | "role",
    id: string,
  ) => Promise<ReaderSubject>;
  addReader?: (
    collection: string,
    subject: ReaderSubject,
    expected: number,
    operation: string,
    actor: string,
  ) => Promise<void>;
  groupName?: (groupId: string) => Promise<string>;
  authority: (lineId: string) => Promise<AdminAuthority>;
  member: (groupId: string, lineId: string) => Promise<boolean>;
  collection: (collectionId: string) => Promise<CollectionApproval>;
  send: (token: string, text: string) => Promise<void>;
}
interface Intent {
  id: string;
  group_id: string;
  line_group_id: string;
  line_actor_id: string;
  account_actor_id: string | null;
  account_binding_generation: string | null;
  admin_authorization_revision: string | null;
  runtime_generation: string;
  group_revision: string;
  revision: string;
  sharing_enabled: boolean;
  collection_id: string | null;
  acl_revision: string | null;
  binding_generation: string | null;
  audience: string[] | null;
  add_reader: ReaderSubject | null;
  state: string;
  expires_at: Date;
  confirmation_hash: string | null;
  confirmation_expires_at: Date | null;
  delivery_id: string | null;
}
const digest = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const positive = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const uuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    value,
  );
function conflict(): never {
  throw new Error("setup_expired_or_changed");
}
export class Registration {
  readonly store: Store;
  readonly ports: RegistrationPorts;
  readonly deliveries: Deliveries;
  constructor(store: Store, ports: RegistrationPorts) {
    this.store = store;
    this.ports = ports;
    this.deliveries = new Deliveries(store);
  }
  async begin(
    groupId: string,
    lineId: string,
    fence?: InteractionFence,
  ): Promise<string> {
    if (!/^C[0-9a-f]{32}$/.test(groupId) || !/^U[0-9a-f]{32}$/.test(lineId))
      conflict();
    const displayName = this.ports.groupName
      ? await this.ports.groupName(groupId)
      : "LINE 群組";
    if (
      !displayName ||
      displayName.length > 200 ||
      /[\x00-\x1f]/.test(displayName)
    )
      conflict();
    const previous = (
      await this.store.pool.query(
        "SELECT state,revision FROM groups WHERE channel_id=$1 AND line_group_id=$2",
        [this.store.channelId, groupId],
      )
    ).rows[0];
    if (previous?.state === "deleted") {
      await this.admin(lineId);
      if (!(await this.ports.member(groupId, lineId))) conflict();
    }
    return this.store.transaction(async (c) => {
      const runtime = (await c.query("SELECT * FROM runtime_state FOR SHARE"))
        .rows[0];
      if (runtime?.mode !== "open") conflict();
      await c.query(
        "INSERT INTO groups(channel_id,line_group_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [this.store.channelId, groupId],
      );
      let group = (
        await c.query(
          "SELECT * FROM groups WHERE channel_id=$1 AND line_group_id=$2 FOR UPDATE",
          [this.store.channelId, groupId],
        )
      ).rows[0];
      await this.store.requireInteraction(c, fence);
      await c.query("UPDATE groups SET display_name=$2 WHERE id=$1", [
        group.id,
        displayName,
      ]);
      if (group.state === "deleting") conflict();
      if (group.state === "deleted") {
        if (
          previous?.state !== "deleted" ||
          previous.revision !== group.revision
        )
          conflict();
        await c.query("DELETE FROM collection_reservations WHERE group_id=$1", [
          group.id,
        ]);
        group = (
          await c.query(
            "UPDATE groups SET state='pending',revision=revision+1,active_from=NULL,sharing_enabled=false,collection_id=NULL,acl_revision=NULL,binding_generation=NULL WHERE id=$1 RETURNING *",
            [group.id],
          )
        ).rows[0];
      }
      // Reuse a live bootstrap on redelivery; approval always requires this actor again.
      const existing = (
        await c.query(
          "SELECT id FROM setup_intents WHERE group_id=$1 AND line_actor_id=$2 AND state='bootstrap' AND expires_at>$3 AND group_revision=$4 AND runtime_generation=$5 ORDER BY expires_at DESC LIMIT 1",
          [
            group.id,
            lineId,
            this.store.now(),
            group.revision,
            runtime.generation,
          ],
        )
      ).rows[0];
      if (existing) return existing.id;
      return (
        await c.query(
          "INSERT INTO setup_intents(group_id,line_actor_id,runtime_generation,group_revision,expires_at) VALUES($1,$2,$3,$4,$5) RETURNING id",
          [
            group.id,
            lineId,
            runtime.generation,
            group.revision,
            new Date(this.store.now().getTime() + 30 * 60_000),
          ],
        )
      ).rows[0].id;
    });
  }
  async read(id: string, lineId: string): Promise<Intent> {
    if (!uuid(id)) conflict();
    const row = (
      await this.store.pool.query<Intent>(
        "SELECT i.*,g.line_group_id FROM setup_intents i JOIN groups g ON g.id=i.group_id WHERE i.id=$1 AND g.channel_id=$2",
        [id, this.store.channelId],
      )
    ).rows[0];
    if (
      !row ||
      row.line_actor_id !== lineId ||
      row.expires_at <= this.store.now()
    )
      conflict();
    return row;
  }
  async admin(lineId: string): Promise<Required<AdminAuthority>> {
    const a = await this.ports.authority(lineId);
    if (
      !a.allowed ||
      !a.bound ||
      !a.actorUserId ||
      !uuid(a.actorUserId) ||
      !positive(a.bindingGeneration) ||
      !positive(a.adminAuthorizationRevision)
    )
      throw new Error("admin_binding_required");
    return a as Required<AdminAuthority>;
  }
  async current(intent: Intent, lineId: string, groupId?: string) {
    const a = await this.admin(lineId);
    if (
      a.actorUserId !== intent.account_actor_id ||
      String(a.bindingGeneration) !== intent.account_binding_generation ||
      String(a.adminAuthorizationRevision) !==
        intent.admin_authorization_revision
    )
      conflict();
    if (
      groupId !== undefined &&
      (groupId !== intent.line_group_id ||
        !(await this.ports.member(groupId, lineId)))
    )
      conflict();
    if (intent.add_reader) {
      if (!this.ports.subject) conflict();
      const subject = await this.ports.subject(
        a.actorUserId,
        intent.add_reader.type,
        intent.add_reader.id,
      );
      if (
        subject.id !== intent.add_reader.id ||
        subject.type !== intent.add_reader.type ||
        subject.label !== intent.add_reader.label
      )
        conflict();
    }
    if (intent.sharing_enabled) {
      const collection = await this.approval(intent.collection_id!);
      if (
        String(collection.aclRevision) !== intent.acl_revision ||
        String(collection.bindingGeneration) !== intent.binding_generation ||
        JSON.stringify(collection.audience) !== JSON.stringify(intent.audience)
      )
        conflict();
    }
  }
  async approval(id: string): Promise<CollectionApproval> {
    if (!isAssetId(id)) conflict();
    const a = await this.ports.collection(id);
    if (
      a.id !== id ||
      !positive(a.aclRevision) ||
      !positive(a.bindingGeneration) ||
      !Array.isArray(a.audience) ||
      a.audience.length > 128 ||
      a.audience.some(
        (s) => typeof s !== "string" || s.length > 256 || /[\x00-\x1f]/.test(s),
      )
    )
      conflict();
    return { ...a, audience: [...a.audience].sort() };
  }
  async locked(
    c: PoolClient,
    original: Intent,
    fence?: InteractionFence,
  ): Promise<Intent> {
    const runtime = (await c.query("SELECT * FROM runtime_state FOR SHARE"))
      .rows[0];
    const group = (
      await c.query("SELECT * FROM groups WHERE id=$1 FOR UPDATE", [
        original.group_id,
      ])
    ).rows[0];
    await this.store.requireInteraction(c, fence);
    const row = (
      await c.query<Intent>(
        "SELECT * FROM setup_intents WHERE id=$1 FOR UPDATE",
        [original.id],
      )
    ).rows[0];
    if (
      !row ||
      row.revision !== original.revision ||
      row.state !== original.state ||
      row.expires_at <= this.store.now() ||
      runtime?.mode !== "open" ||
      runtime.generation !== row.runtime_generation ||
      group?.revision !== row.group_revision ||
      ["deleting", "deleted"].includes(group.state)
    )
      conflict();
    return row;
  }
  async reservationLock(c: PoolClient, collectionId: string) {
    // Serialize reclamation with draft changes and the start of external effects.
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      collectionId,
    ]);
    await c.query(
      `DELETE FROM collection_reservations r WHERE r.collection_id=$1
      AND NOT EXISTS(SELECT 1 FROM groups g WHERE g.id=r.group_id AND g.collection_id=r.collection_id)
      AND NOT EXISTS(SELECT 1 FROM setup_intents i JOIN groups g ON g.id=i.group_id CROSS JOIN runtime_state rt WHERE i.group_id=r.group_id AND i.collection_id=r.collection_id AND
        (i.state IN ('announcing','unknown','active') OR i.expires_at>$2 AND i.group_revision=g.revision AND i.runtime_generation=rt.generation))
      AND NOT EXISTS(SELECT 1 FROM publications p WHERE p.collection_id=r.collection_id AND p.removed_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM sources s WHERE s.group_id=r.group_id AND s.publication_collection_id=r.collection_id)`,
      [collectionId, this.store.now()],
    );
  }
  async configure(
    id: string,
    lineId: string,
    config: {
      sharing: boolean;
      collectionId?: string;
      addReader?: { type: "user" | "role"; id: string };
    },
    websiteActorId?: string,
    expectedRevision?: number,
  ): Promise<void> {
    const intent = await this.read(id, lineId);
    if (
      expectedRevision !== undefined &&
      String(expectedRevision) !== intent.revision
    )
      conflict();
    if (
      !["bootstrap", "draft", "preview"].includes(intent.state) ||
      typeof config.sharing !== "boolean" ||
      config.sharing !== Boolean(config.collectionId)
    )
      conflict();
    const a = await this.admin(lineId);
    if (websiteActorId !== undefined && websiteActorId !== a.actorUserId)
      conflict();
    const collection = config.sharing
      ? await this.approval(config.collectionId!)
      : undefined;
    let reader: ReaderSubject | null = null;
    if (config.addReader) {
      const r = config.addReader;
      if (
        !collection ||
        !this.ports.subject ||
        !this.ports.addReader ||
        !["user", "role"].includes(r.type) ||
        !uuid(r.id) ||
        collection.audience.includes(`${r.type}:${r.id}`)
      )
        conflict();
      reader = await this.ports.subject(a.actorUserId, r.type, r.id);
      if (
        reader.id !== r.id ||
        reader.type !== r.type ||
        !reader.label ||
        reader.label.length > 200 ||
        /[\x00-\x1f]/.test(reader.label)
      )
        conflict();
    }
    this.notice({
      ...intent,
      sharing_enabled: config.sharing,
      audience: collection?.audience ?? [],
      add_reader: reader,
    });
    await this.store.transaction(async (c) => {
      await this.locked(c, intent);
      const group = (
        await c.query(
          "SELECT collection_id,acl_revision,binding_generation FROM groups WHERE id=$1",
          [intent.group_id],
        )
      ).rows[0];
      if (collection) {
        await this.reservationLock(c, collection.id);
        const reserved = await c.query(
          `INSERT INTO collection_reservations(collection_id,group_id,binding_generation,reserved_at) VALUES($1,$2,$3,$4)
      ON CONFLICT(collection_id) DO UPDATE SET reserved_at=collection_reservations.reserved_at
      WHERE collection_reservations.group_id=EXCLUDED.group_id AND collection_reservations.binding_generation=EXCLUDED.binding_generation RETURNING collection_id`,
          [
            collection.id,
            intent.group_id,
            collection.bindingGeneration,
            this.store.now(),
          ],
        );
        if (!reserved.rowCount) conflict();
      }
      await c.query(
        `UPDATE setup_intents SET account_actor_id=$2,account_binding_generation=$3,admin_authorization_revision=$4,
     sharing_enabled=$5,collection_id=$6,acl_revision=$7,binding_generation=$8,audience=$9,add_reader=$10,state='draft',revision=revision+1,confirmation_hash=NULL,confirmation_expires_at=NULL WHERE id=$1`,
        [
          id,
          a.actorUserId,
          a.bindingGeneration,
          a.adminAuthorizationRevision,
          config.sharing,
          collection?.id ?? group.collection_id,
          collection?.aclRevision ?? group.acl_revision,
          collection?.bindingGeneration ?? group.binding_generation,
          collection ? JSON.stringify(collection.audience) : null,
          reader ? JSON.stringify(reader) : null,
        ],
      );
      await c.query(
        "INSERT INTO audit_outbox(action,actor_user_id,target_id,target_revision,occurred_at) VALUES('line.group.configure',$1,$2,$3,$4)",
        [
          a.actorUserId,
          intent.group_id,
          intent.group_revision,
          this.store.now(),
        ],
      );
    });
  }
  notice(intent: Intent) {
    const text = `群組設定確認：啟用期間收錄全體成員的新訊息與附件，從發布起保存 90 天；現在及未來成員可查詢有效資料。附件不掃描病毒、不轉檔，圖片／影音只收錄資訊，不辨識內容；PDF 僅擷取內嵌文字、試算表僅讀值。查詢可能交由 OpenAI／Azure 處理。成員可預覽確認刪除本人資料；網站全域管理員可暫停、恢復或刪除。暫停停收停讀、期限照算；恢復不回補，不主動推播。${intent.sharing_enabled ? `Presenter 媒體分享對象：${intent.audience?.join("、") || "無讀者"}；角色讀者隨目前角色成員變更。授權者可下載至裝置，沿用原 90 天期限；切換資料集不搬移歷史素材。` : "Presenter 分享關閉。"}已匯出的離線副本無法即時收回。${intent.add_reader ? `公告成功後新增${intent.add_reader.type === "role" ? "角色" : "使用者"}讀者：${intent.add_reader.label}（${intent.add_reader.id}）。` : ""}`;
    if (text.length > 4500) throw Error("audience_too_large");
    return text;
  }
  async preview(
    id: string,
    lineId: string,
    groupId: string,
    fence?: InteractionFence,
  ): Promise<{ token: string; text: string }> {
    const intent = await this.read(id, lineId);
    if (!["draft", "preview"].includes(intent.state)) conflict();
    await this.current(intent, lineId, groupId);
    const token = randomBytes(32).toString("base64url");
    await this.store.transaction(async (c) => {
      await this.locked(c, intent, fence);
      await c.query(
        "UPDATE setup_intents SET state='preview',revision=revision+1,confirmation_hash=$2,confirmation_expires_at=$3 WHERE id=$1",
        [
          id,
          digest(token),
          new Date(
            Math.min(
              intent.expires_at.getTime(),
              this.store.now().getTime() + 5 * 60_000,
            ),
          ),
        ],
      );
    });
    return { token, text: this.notice(intent) };
  }
  async confirm(
    id: string,
    token: string,
    lineId: string,
    groupId: string,
    deliveryId: string,
    fence?: InteractionFence,
  ): Promise<void> {
    const intent = await this.read(id, lineId);
    if (
      intent.state !== "preview" ||
      !/^[A-Za-z0-9_-]{43}$/.test(token) ||
      intent.confirmation_hash !== digest(token) ||
      !intent.confirmation_expires_at ||
      intent.confirmation_expires_at <= this.store.now()
    )
      conflict();
    await this.current(intent, lineId, groupId);
    await this.store.transaction(async (c) => {
      await this.locked(c, intent, fence);
      if (intent.sharing_enabled) {
        await this.reservationLock(c, intent.collection_id!);
        const reservation = await c.query(
          "SELECT 1 FROM collection_reservations WHERE collection_id=$1 AND group_id=$2 AND binding_generation=$3",
          [intent.collection_id, intent.group_id, intent.binding_generation],
        );
        if (!reservation.rowCount) conflict();
      }
      const d = (
        await c.query("SELECT * FROM deliveries WHERE id=$1 FOR UPDATE", [
          deliveryId,
        ])
      ).rows[0];
      if (
        !d ||
        d.channel_id !== this.store.channelId ||
        d.actor_id !== lineId ||
        d.scope_id !== groupId ||
        d.state !== "pending" ||
        d.body !== null ||
        d.expires_at <= this.store.now() ||
        d.runtime_generation !== intent.runtime_generation
      )
        conflict();
      await c.query(
        "UPDATE deliveries SET group_id=$2,group_revision=$3,body=$4 WHERE id=$1",
        [
          deliveryId,
          intent.group_id,
          intent.group_revision,
          this.notice(intent) + " 收錄將於本次公告成功且批准版本提交後開始。",
        ],
      );
      await c.query(
        "UPDATE setup_intents SET state='announcing',revision=revision+1,confirmation_hash=NULL,delivery_id=$2 WHERE id=$1",
        [id, deliveryId],
      );
    });
    const result = await this.deliveries.deliver(deliveryId, this.ports.send);
    if (result !== "delivered") {
      await this.store.pool.query(
        "UPDATE setup_intents SET state='unknown',revision=revision+1 WHERE id=$1 AND state='announcing'",
        [id],
      );
      throw new Error("announcement_unconfirmed");
    }
    const pending = await this.read(id, lineId);
    await this.current(pending, lineId, groupId);
    let approved = pending;
    if (pending.add_reader) {
      if (!this.ports.addReader) conflict();
      // The announced intent is the durable mutation key; an unknown result never replays Reply.
      await this.ports.addReader(
        pending.collection_id!,
        pending.add_reader,
        Number(pending.acl_revision),
        digest(`${pending.id}:${pending.revision}:acl`),
        pending.account_actor_id!,
      );
      const collection = await this.approval(pending.collection_id!);
      const audience = [
        ...pending.audience!,
        `${pending.add_reader.type}:${pending.add_reader.id}`,
      ].sort();
      if (
        collection.aclRevision !== Number(pending.acl_revision) + 1 ||
        String(collection.bindingGeneration) !== pending.binding_generation ||
        JSON.stringify(collection.audience) !== JSON.stringify(audience)
      )
        conflict();
      approved = {
        ...pending,
        acl_revision: String(collection.aclRevision),
        audience,
      };
      await this.current(approved, lineId, groupId);
    }
    await this.store.transaction(async (c) => {
      await this.locked(c, pending, fence);
      if (pending.state !== "announcing") conflict();
      await c.query(
        `UPDATE groups SET active_from=CASE WHEN state='active' THEN active_from ELSE $2 END,state='active',revision=revision+1,sharing_enabled=$3,collection_id=$4,acl_revision=$5,binding_generation=$6 WHERE id=$1`,
        [
          pending.group_id,
          this.store.now(),
          pending.sharing_enabled,
          pending.collection_id,
          approved.acl_revision,
          pending.binding_generation,
        ],
      );
      if (pending.sharing_enabled) {
        await c.query(
          "UPDATE publications SET acl_revision=$3 WHERE source_id IN (SELECT id FROM sources WHERE group_id=$1 AND expires_at>$4 AND state NOT IN ('revoked','expired')) AND collection_id=$2 AND binding_generation=$5 AND state<>'revoked'",
          [
            pending.group_id,
            pending.collection_id,
            approved.acl_revision,
            this.store.now(),
            pending.binding_generation,
          ],
        );
        await c.query(
          "UPDATE sources SET publication_acl_revision=$3 WHERE group_id=$1 AND publication_collection_id=$2 AND publication_binding_generation=$4 AND expires_at>$5 AND state NOT IN ('revoked','expired')",
          [
            pending.group_id,
            pending.collection_id,
            approved.acl_revision,
            pending.binding_generation,
            this.store.now(),
          ],
        );
      }
      await c.query(
        "UPDATE jobs SET state='queued',available_at=$2,lease_until=NULL FROM sources s WHERE jobs.source_id=s.id AND s.group_id=$1 AND jobs.state='held' AND s.expires_at>$2 AND s.state NOT IN ('revoked','expired')",
        [pending.group_id, this.store.now()],
      );
      await c.query(
        "INSERT INTO job_wakes(job_id,created_at) SELECT j.id,$2 FROM jobs j JOIN sources s ON s.id=j.source_id WHERE s.group_id=$1 AND j.state='queued' ON CONFLICT(job_id) DO UPDATE SET delivered_at=NULL",
        [pending.group_id, this.store.now()],
      );
      await c.query(
        "UPDATE setup_intents SET state='active',revision=revision+1,acl_revision=$2,audience=$3 WHERE id=$1",
        [
          id,
          approved.acl_revision,
          approved.audience ? JSON.stringify(approved.audience) : null,
        ],
      );
      await c.query(
        "INSERT INTO audit_outbox(action,actor_user_id,target_id,target_revision,occurred_at) VALUES('line.group.activate',$1,$2,$3,$4)",
        [
          pending.account_actor_id,
          pending.group_id,
          String(BigInt(pending.group_revision) + 1n),
          this.store.now(),
        ],
      );
    });
  }
}
