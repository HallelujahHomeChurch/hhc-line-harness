import { randomUUID, randomBytes, createHash } from "node:crypto";
import type { Store, InteractionFence } from "../persistence/store.ts";
import type { Search } from "../search/search.ts";
import type { AdminAuthority } from "./registration.ts";
import { Conversations } from "./conversations.ts";
import { invalidate, sourceKey } from "./lifecycle.ts";
import { terms } from "../search/terms.ts";
type Edit = { kind: "description"; text: string } | { kind: "delete" };
const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export class SourceEdits {
  readonly store: Store;
  readonly search: Search;
  readonly authority: (actor: string) => Promise<AdminAuthority>;
  readonly conversations: Conversations;
  constructor(
    store: Store,
    search: Search,
    authority: (actor: string) => Promise<AdminAuthority>,
  ) {
    this.store = store;
    this.search = search;
    this.authority = authority;
    this.conversations = new Conversations(store, search);
  }
  async principal(actor: string, author: string | null) {
    if (actor === author) return { kind: "author" };
    const admin = await this.authority(actor);
    if (
      !admin.allowed ||
      !admin.bound ||
      typeof admin.actorUserId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        admin.actorUserId,
      ) ||
      !Number.isSafeInteger(admin.bindingGeneration) ||
      Number(admin.bindingGeneration) < 1 ||
      !Number.isSafeInteger(admin.adminAuthorizationRevision) ||
      Number(admin.adminAuthorizationRevision) < 1
    )
      throw new Error("edit_forbidden");
    return {
      kind: "admin",
      actorUserId: admin.actorUserId,
      bindingGeneration: admin.bindingGeneration,
      adminAuthorizationRevision: admin.adminAuthorizationRevision,
    };
  }
  async preview(
    groupId: string,
    actor: string,
    sourceId: string,
    edit: Edit,
    fence?: InteractionFence,
  ) {
    if (
      !/^[0-9a-f-]{36}$/.test(sourceId) ||
      !edit ||
      !["description", "delete"].includes(edit.kind) ||
      Object.keys(edit).some(
        (k) =>
          !(edit.kind === "description" ? ["kind", "text"] : ["kind"]).includes(
            k,
          ),
      ) ||
      (edit.kind === "description" &&
        (typeof edit.text !== "string" ||
          !edit.text.trim() ||
          [...edit.text].length > 1000 ||
          /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(edit.text)))
    )
      throw new Error("invalid_edit");
    const scope = await this.search.scope(groupId, actor);
    const source = (
      await this.store.pool.query(
        "SELECT * FROM sources WHERE id=$1 AND group_id=$2",
        [sourceId, groupId],
      )
    ).rows[0];
    if (
      !source ||
      source.state !== "ready" ||
      source.expires_at <= this.store.now()
    )
      throw new Error("edit_expired");
    const principal = await this.principal(actor, source.author_id),
      id = randomUUID(),
      token = randomBytes(32).toString("base64url");
    await this.store.transaction(async (c) => {
      const session = await this.conversations.session(
        c,
        groupId,
        actor,
        scope.generation,
        fence,
      );
      const current = (
        await c.query("SELECT * FROM sources WHERE id=$1 FOR SHARE", [sourceId])
      ).rows[0];
      const group = (
        await c.query("SELECT revision FROM groups WHERE id=$1", [groupId])
      ).rows[0];
      if (
        current.revision !== source.revision ||
        current.description_revision !== source.description_revision ||
        group.revision !== scope.revision ||
        current.expires_at <= this.store.now()
      )
        throw new Error("edit_expired");
      await c.query(
        `INSERT INTO source_edits(id,group_id,source_id,actor_id,conversation_id,conversation_generation,runtime_generation,group_revision,source_revision,description_revision,authority,kind,text_ciphertext,confirmation_hash,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          id,
          groupId,
          sourceId,
          actor,
          session.id,
          session.generation,
          scope.generation,
          scope.revision,
          source.revision,
          source.description_revision,
          principal,
          edit.kind,
          edit.kind === "description"
            ? this.store.cipher.sealPayload(edit.text, `source-edit:${id}`)
            : null,
          hash(token),
          new Date(this.store.now().getTime() + 5 * 60_000),
        ],
      );
    });
    return {
      id,
      token,
      text: `目標：${source.file_name ?? "文字訊息"}\n發布：${source.published_at.toISOString()}\n${edit.kind === "description" ? `原說明：${source.description ?? "（無）"}\n新說明：${edit.text}` : "將刪除此來源及其分享、索引與查詢結果。"}\n不改變原始內容或 90 天期限。請在 5 分鐘內由本人確認。`,
    };
  }
  async confirm(
    groupId: string,
    actor: string,
    id: string,
    token: string,
    fence?: InteractionFence,
  ) {
    if (!/^[0-9a-f-]{36}$/.test(id) || !/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new Error("edit_forbidden");
    const scope = await this.search.scope(groupId, actor);
    const preview = (
      await this.store.pool.query("SELECT * FROM source_edits WHERE id=$1", [
        id,
      ])
    ).rows[0];
    if (
      !preview ||
      preview.actor_id !== actor ||
      preview.group_id !== groupId ||
      preview.confirmation_hash !== hash(token)
    )
      throw new Error("edit_forbidden");
    const source = (
      await this.store.pool.query("SELECT * FROM sources WHERE id=$1", [
        preview.source_id,
      ])
    ).rows[0];
    const authority = await this.principal(actor, source?.author_id ?? null);
    await this.store.transaction(async (c) => {
      const runtime = (await c.query("SELECT * FROM runtime_state FOR SHARE"))
        .rows[0];
      const group = (
        await c.query("SELECT * FROM groups WHERE id=$1 FOR UPDATE", [groupId])
      ).rows[0];
      const session = (
        await c.query("SELECT * FROM conversations WHERE id=$1 FOR UPDATE", [
          preview.conversation_id,
        ])
      ).rows[0];
      await this.store.requireInteraction(c, fence);
      const current = (
        await c.query("SELECT * FROM sources WHERE id=$1 FOR UPDATE", [
          preview.source_id,
        ])
      ).rows[0];
      const operation = (
        await c.query("SELECT * FROM source_edits WHERE id=$1 FOR UPDATE", [id])
      ).rows[0];
      if (
        runtime.mode !== "open" ||
        runtime.generation !== operation.runtime_generation ||
        scope.generation !== runtime.generation ||
        group.state !== "active" ||
        group.revision !== operation.group_revision ||
        scope.revision !== group.revision ||
        !session ||
        session.generation !== operation.conversation_generation ||
        session.last_interaction_at.getTime() + 30 * 60_000 <=
          this.store.now().getTime() ||
        operation.state !== "preview" ||
        operation.expires_at <= this.store.now() ||
        current.state !== "ready" ||
        current.expires_at <= this.store.now() ||
        current.revision !== operation.source_revision ||
        current.description_revision !== operation.description_revision ||
        Object.keys(authority).length !==
          Object.keys(operation.authority).length ||
        Object.entries(authority).some(
          ([key, value]) => operation.authority[key] !== value,
        )
      )
        throw new Error("edit_expired");
      if (operation.kind === "delete") {
        await c.query(
          "INSERT INTO source_tombstones(source_key,revoked_at,expires_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [
            sourceKey(
              this.store.channelId,
              group.line_group_id,
              current.message_id,
            ),
            this.store.now(),
            new Date(this.store.now().getTime() + 120 * 86400000),
          ],
        );
        await invalidate(c, current.id, this.store.now(), "revoked");
      } else {
        const text = this.store.cipher.openPayload(
          operation.text_ciphertext,
          `source-edit:${id}`,
        );
        await c.query(
          "UPDATE sources SET description=$2,description_revision=description_revision+1 WHERE id=$1",
          [current.id, text],
        );
        const index = (
          await c.query(
            "SELECT extracted_text FROM source_indexes WHERE source_id=$1",
            [current.id],
          )
        ).rows[0];
        if (index)
          await c.query(
            "UPDATE source_indexes SET terms=$2 WHERE source_id=$1",
            [
              current.id,
              terms(
                [current.file_name, text, index.extracted_text]
                  .filter(Boolean)
                  .join("\n"),
              ),
            ],
          );
        await c.query(
          "UPDATE search_jobs SET state='cancelled',result_ciphertext=NULL,source_ids='{}' WHERE $1::uuid=ANY(source_ids)",
          [current.id],
        );
      }
      await c.query(
        "INSERT INTO audit_outbox(id,action,actor_user_id,target_id,target_revision,occurred_at) VALUES($1,$2,$3,$4,$5,$6)",
        [
          id,
          `line.source.${operation.kind}`,
          authority.kind === "admin" ? authority.actorUserId : null,
          current.id,
          String(
            BigInt(
              operation.kind === "description"
                ? current.description_revision
                : current.revision,
            ) + 1n,
          ),
          this.store.now(),
        ],
      );
      await c.query(
        "UPDATE source_edits SET state='completed',text_ciphertext=NULL WHERE id=$1",
        [id],
      );
      await c.query(
        "UPDATE conversations SET last_interaction_at=$2 WHERE id=$1",
        [session.id, this.store.now()],
      );
    });
  }
}
