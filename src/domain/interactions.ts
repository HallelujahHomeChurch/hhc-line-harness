import type { AdminQueries } from "./admin-queries.ts";
import type { SourceEdits } from "./source-edits.ts";
import type { Conversations } from "./conversations.ts";
import type { Management } from "./management.ts";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { Store, IntakeGroup } from "../persistence/store.ts";
import type { LineEvent } from "./events.ts";
import { Registration } from "./registration.ts";
import type { ReplyAction } from "../providers/line.ts";
import { Deliveries } from "../reply/deliveries.ts";
interface Ports {
  adminQueries?: AdminQueries;
  conversations?: Conversations;
  sourceEdits?: SourceEdits;
  liffId?: string;
  management?: Management;
  binding: (userId: string) => Promise<string>;
  finalize: (
    userId: string,
    nonce: string,
    result: "ok" | "failed",
    eventId: string,
  ) => Promise<void>;
  send: (token: string, text: string, actions?: ReplyAction[]) => Promise<void>;
  adminOrigin: string;
}
interface Interaction {
  id: string;
  event_id: string;
  actor_id: string;
  scope_id: string;
  kind: string;
  payload_ciphertext: string | null;
  delivery_id: string | null;
  fence: string;
}
export class Interactions {
  readonly store: Store;
  readonly registration: Registration;
  readonly ports: Ports;
  readonly deliveries: Deliveries;
  constructor(store: Store, registration: Registration, ports: Ports) {
    this.store = store;
    this.registration = registration;
    this.ports = ports;
    this.deliveries = new Deliveries(store);
    const origin = new URL(ports.adminOrigin);
    if (origin.protocol !== "https:" || origin.origin !== ports.adminOrigin)
      throw new Error("invalid_admin_origin");
  }
  async record(
    c: PoolClient,
    event: LineEvent,
    group?: IntakeGroup,
  ): Promise<void> {
    if (!event.actorId || event.scope === "room") return;
    let kind: string | undefined;
    let payload: unknown = {};
    if (event.type === "accountLink" && event.accountLink) {
      kind = "binding";
      payload = event.accountLink;
    } else if (
      event.scope === "user" &&
      event.type === "postback" &&
      /^manage:(page|select|pause|delete|confirm):[0-9a-f-]{36}(?::[0-9]+|:[A-Za-z0-9_-]{43})?$/.test(
        event.postback ?? "",
      )
    ) {
      const [, action, id, value] = event.postback!.split(":");
      kind = "management";
      payload = { action, id, value };
    } else if (
      event.type === "postback" &&
      /^setup:(preview|confirm):[0-9a-f-]{36}(?::[A-Za-z0-9_-]{43})?$/.test(
        event.postback ?? "",
      )
    ) {
      const [, action, intent, token] = event.postback!.split(":");
      kind = action;
      payload = { intent, token };
    } else if (
      event.scope === "group" &&
      event.message?.mentionsBot &&
      /(啟用|設定|恢復)/.test(event.message.text ?? "")
    ) {
      kind = "bootstrap";
    } else if (
      event.scope === "group" &&
      group?.state === "active" &&
      /^agent:preview:[0-9a-f-]{36}$/.test(event.postback ?? "")
    ) {
      kind = "source-proposal";
      payload = { id: event.postback!.split(":")[2] };
    } else if (
      event.scope === "group" &&
      group?.state === "active" &&
      /^edit:confirm:[0-9a-f-]{36}:[A-Za-z0-9_-]{43}$/.test(
        event.postback ?? "",
      )
    ) {
      const [, , id, token] = event.postback!.split(":");
      kind = "source-confirm";
      payload = { id, token };
    } else if (
      event.scope === "group" &&
      group?.state === "active" &&
      event.message?.mentionsBot &&
      event.message.quotedMessageId &&
      /(?:補充說明|刪除此資料)/.test(event.message.text ?? "")
    ) {
      kind = "source-preview";
      payload = {
        messageId: event.message.quotedMessageId,
        edit: /刪除此資料/.test(event.message.text ?? "")
          ? { kind: "delete" }
          : {
              kind: "description",
              text: (event.message.text ?? "")
                .split("補充說明")
                .slice(1)
                .join("補充說明")
                .trim(),
            },
      };
    } else if (
      event.scope === "group" &&
      group?.state === "active" &&
      event.message?.mentionsBot &&
      event.message.text
    ) {
      kind = /(?:重設對話|重置對話)/.test(event.message.text)
        ? "conversation-reset"
        : /查看(?:查詢)?結果/.test(event.message.text)
          ? "search-list"
          : "search";
      payload = {
        messageId: event.message.id,
        useAgent: !/(?:搜尋|查詢)/.test(event.message.text),
        query: event.message.text
          .replace(/^.*?(?:搜尋|查詢)\s*/, "")
          .slice(0, 200),
      };
    } else if (
      event.scope === "group" &&
      group?.state === "active" &&
      /^search:(?:get|list):[0-9a-f-]{36}$/.test(event.postback ?? "")
    ) {
      kind = event.postback!.startsWith("search:list:")
        ? "search-list"
        : "search-get";
      payload = { id: event.postback!.split(":")[2] };
    } else if (
      event.scope === "user" &&
      this.ports.adminQueries &&
      /^admin-agent:(?:get:[0-9a-f-]{36}|list(?::[0-9a-f-]{36})?|reset)$/.test(
        event.postback ?? "",
      )
    ) {
      const [, action, id] = event.postback!.split(":");
      kind = `admin-${action}`;
      payload = { id };
    } else if (
      event.scope === "user" &&
      this.ports.adminQueries &&
      event.message?.type === "text" &&
      event.message.text &&
      !/^(?:管理|選單|綁定|help)$/i.test(event.message.text.trim())
    ) {
      kind = /(?:重設對話|重置對話)/.test(event.message.text)
        ? "admin-reset"
        : /查看(?:查詢)?結果/.test(event.message.text)
          ? "admin-list"
          : "admin-query";
      payload = { query: event.message.text.slice(0, 200) };
    } else if (event.scope === "user" && event.type === "message")
      kind = "help";
    if (!kind) return;
    const id = randomUUID();
    const delivery = event.replyToken
      ? await this.deliveries.create(c, {
          eventId: event.id,
          token: event.replyToken,
          publishedAt: event.publishedAt,
          actorId: event.actorId,
          scopeId: event.scopeId,
          groupId: group?.id,
          groupRevision: group?.revision,
        })
      : undefined;
    await c.query(
      `INSERT INTO interactions(id,channel_id,event_id,actor_id,scope_id,runtime_generation,kind,payload_ciphertext,delivery_id,created_at,expires_at)
   SELECT $1,$2,$3,$4,$5,generation,$6,$7,$8,$9,$10 FROM runtime_state WHERE mode='open'`,
      [
        id,
        this.store.channelId,
        event.id,
        event.actorId,
        event.scopeId,
        kind,
        this.store.cipher.sealPayload(
          JSON.stringify(payload),
          `interaction:${id}`,
        ),
        delivery,
        this.store.now(),
        new Date(this.store.now().getTime() + 10 * 60_000),
      ],
    );
  }
  groupState(state: string) {
    return (
      (
        {
          pending: "等待確認",
          active: "收錄中",
          paused: "已暫停",
          left: "Bot 已離群",
          deleting: "刪除中",
          deleted: "已刪除",
        } as Record<string, string>
      )[state] ?? "請重新確認狀態"
    );
  }
  async claim(): Promise<Interaction | undefined> {
    return this.store.transaction(async (c) => {
      const now = this.store.now();
      // A crashed command is recovered by a new interaction, never by replaying its side effects.
      await c.query(
        "UPDATE interactions SET state='failed',payload_ciphertext=NULL WHERE (state='running' AND lease_until<=$1) OR (state='queued' AND expires_at<=$1)",
        [now],
      );
      const row = (
        await c.query<Interaction>(
          `SELECT i.* FROM interactions i JOIN runtime_state r ON r.mode='open' AND r.generation=i.runtime_generation
    WHERE i.channel_id=$1 AND i.state='queued' AND NOT EXISTS(SELECT 1 FROM interactions older WHERE older.channel_id=i.channel_id AND older.scope_id=i.scope_id AND older.actor_id=i.actor_id AND older.sequence<i.sequence AND older.state IN ('queued','running')) ORDER BY i.sequence FOR UPDATE OF i SKIP LOCKED LIMIT 1`,
          [this.store.channelId],
        )
      ).rows[0];
      if (!row) return;
      const fence = (
        await c.query(
          "UPDATE interactions SET state='running',fence=fence+1,lease_until=$2 WHERE id=$1 RETURNING fence",
          [row.id, new Date(now.getTime() + 30_000)],
        )
      ).rows[0].fence;
      return { ...row, fence };
    });
  }
  async processOne(): Promise<boolean> {
    const row = await this.claim();
    if (!row) return false;
    let state = "completed";
    try {
      const payload = JSON.parse(
        this.store.cipher.openPayload(
          row.payload_ciphertext!,
          `interaction:${row.id}`,
        ),
      ) as {
        messageId?: string;
        edit?: { kind: "description"; text: string } | { kind: "delete" };
        query?: string;
        useAgent?: boolean;
        action?: string;
        id?: string;
        value?: string;
        intent?: string;
        token?: string;
        nonce?: string;
        result?: "ok" | "failed";
      };
      let beforeReply: (() => Promise<unknown>) | undefined;
      let text: string | undefined;
      let actions: ReplyAction[] | undefined;
      if (
        ["source-preview", "source-confirm", "source-proposal"].includes(
          row.kind,
        )
      ) {
        const edits = this.ports.sourceEdits;
        if (!edits) throw new Error("edit_unavailable");
        const group = (
          await this.store.pool.query(
            "SELECT id FROM groups WHERE channel_id=$1 AND line_group_id=$2",
            [this.store.channelId, row.scope_id],
          )
        ).rows[0];
        if (!group) throw new Error("edit_forbidden");
        if (row.kind === "source-preview" || row.kind === "source-proposal") {
          const draft =
            row.kind === "source-proposal"
              ? (
                  await this.ports.conversations?.read(
                    payload.id!,
                    row.actor_id,
                    group.id,
                    row,
                  )
                )?.result?.proposal
              : undefined;
          if (row.kind === "source-proposal" && !draft)
            throw new Error("edit_expired");
          const source = draft
            ? { id: draft.sourceId }
            : (
                await this.store.pool.query(
                  "SELECT id FROM sources WHERE group_id=$1 AND message_id=$2",
                  [group.id, payload.messageId],
                )
              ).rows[0];
          if (!source) throw new Error("edit_expired");
          const preview = await edits.preview(
            group.id,
            row.actor_id,
            source.id,
            draft
              ? draft.kind === "delete"
                ? { kind: "delete" }
                : { kind: "description", text: draft.text }
              : payload.edit!,
            row,
          );
          text = preview.text;
          actions = [
            {
              label: "確認變更",
              data: `edit:confirm:${preview.id}:${preview.token}`,
            },
          ];
        } else {
          await edits.confirm(
            group.id,
            row.actor_id,
            payload.id!,
            payload.token!,
            row,
          );
          text = "資料變更已完成。";
        }
      } else if (
        ["search", "search-get", "search-list", "conversation-reset"].includes(
          row.kind,
        )
      ) {
        const conversations = this.ports.conversations;
        if (!conversations) throw new Error("search_unavailable");
        const group = (
          await this.store.pool.query(
            "SELECT id FROM groups WHERE channel_id=$1 AND line_group_id=$2",
            [this.store.channelId, row.scope_id],
          )
        ).rows[0];
        if (!group) throw new Error("search_forbidden");
        if (row.kind === "conversation-reset") {
          await conversations.reset(group.id, row.actor_id, row);
          text = "已重設你的本群組對話；群組原始資料仍保留。";
        } else if (row.kind === "search") {
          const excluded = (
            await this.store.pool.query(
              "SELECT id FROM sources WHERE group_id=$1 AND message_id=$2",
              [group.id, payload.messageId],
            )
          ).rows[0]?.id;
          const job = await conversations.start(
            group.id,
            row.actor_id,
            { query: payload.query! },
            row,
            excluded,
            payload.useAgent,
          );
          text = "已受理查詢。請稍後點選查看結果；不會另行推播。";
          if (this.ports.liffId)
            text += `\n搜尋與下載：https://liff.line.me/${this.ports.liffId}?group=${group.id}&result=${job.id}`;
          actions = [{ label: "查看查詢結果", data: `search:get:${job.id}` }];
        } else if (row.kind === "search-list") {
          const jobs = await conversations.candidates(
            group.id,
            row.actor_id,
            payload.id,
          );
          const stateName = (state: string) =>
            state === "ready"
              ? "可領取"
              : state === "failed"
                ? "失敗"
                : "處理中";
          text = jobs.length
            ? "你的查詢工作，請選擇要查看的結果：\n" +
              jobs
                .map(
                  (j, i) =>
                    `${i + 1}. ${j.created_at.toISOString()} · ${stateName(j.state)}`,
                )
                .join("\n")
            : "目前沒有可領取的查詢工作，請重新提出查詢。";
          actions = jobs.map((j, i) => ({
            label: `${i + 1}. ${stateName(j.state)}`,
            data: `search:get:${j.id}`,
          }));
          if (jobs.length === 5)
            actions.push({
              label: "更多工作",
              data: `search:list:${jobs.at(-1)!.id}`,
            });
        } else {
          const status = await conversations.read(
            payload.id!,
            row.actor_id,
            group.id,
            row,
          );
          if (status.result) {
            text =
              status.result.items
                .map(
                  (i, n) =>
                    `${n + 1}. ${i.name.slice(0, 120)}\n作者：${i.authorId ?? "未知"}；發布：${i.publishedAt}\n${i.snippet.slice(0, 200)}\n${i.gaps.length ? "適用期間與版本仍需依原群組公告確認。" : ""}`,
                )
                .join("\n\n") ||
              (status.result.status === "not_found"
                ? "未找到符合的資料。"
                : status.result.status === "unavailable"
                  ? "文字搜尋暫時無法完成，請稍後重試。"
                  : "索引尚未完成，請稍後重試。");
          } else
            text =
              status.state === "failed"
                ? "查詢暫時無法完成，請重新提出查詢。"
                : "查詢處理中，請稍後再查看。";
          if (this.ports.liffId)
            text += `\n搜尋與下載：https://liff.line.me/${this.ports.liffId}?group=${group.id}&result=${payload.id}`;
          if (status.state !== "failed")
            actions = [{ label: "再次查看", data: `search:get:${payload.id}` }];
          if (status.result?.gaps.includes("agent_unavailable_basic_search"))
            text += "\n智能查詢暫時無法完成，目前顯示關鍵字搜尋結果。";
          if (status.result?.proposal) {
            text += "\n有一項變更草稿；尚未修改資料，請先預覽。";
            actions?.push({
              label: "預覽變更草稿",
              data: `agent:preview:${payload.id}`,
            });
          }
        }
      } else if (
        ["admin-query", "admin-get", "admin-list", "admin-reset"].includes(
          row.kind,
        )
      ) {
        const queries = this.ports.adminQueries;
        if (!queries) throw new Error("management_unavailable");
        beforeReply = () => this.registration.admin(row.actor_id);
        if (row.kind === "admin-query") {
          const job = await queries.start(row.actor_id, payload.query!, row);
          text = "已受理管理查詢。請稍後領取結果；不會另行推播。";
          actions = [
            { label: "查看管理查詢結果", data: `admin-agent:get:${job.id}` },
          ];
        } else if (row.kind === "admin-reset") {
          await queries.reset(row.actor_id, row);
          text = "已重設你的管理對話；群組資料與設定仍保留。";
        } else if (row.kind === "admin-list") {
          const jobs = await queries.candidates(row.actor_id, payload.id);
          text = jobs.length
            ? "請選擇要查看的管理查詢工作。"
            : "目前沒有可領取的管理查詢工作。";
          actions = jobs.map((j, i) => ({
            label: `${i + 1}. ${j.state === "ready" ? "可領取" : j.state === "failed" ? "失敗" : "處理中"}`,
            data: `admin-agent:get:${j.id}`,
          }));
          if (jobs.length === 5)
            actions.push({
              label: "更多工作",
              data: `admin-agent:list:${jobs.at(-1)!.id}`,
            });
        } else {
          const status = await queries.read(payload.id!, row.actor_id, row);
          beforeReply = () => queries.read(payload.id!, row.actor_id);
          if (!status.result) {
            text =
              status.state === "failed"
                ? "管理查詢未完成，請重新查詢或使用管理選單。"
                : "管理查詢處理中，請稍後查看。";
            actions = [
              { label: "再次查看", data: `admin-agent:get:${payload.id}` },
            ];
          } else {
            const result = status.result;
            text =
              "管理查詢結果（僅狀態，不提供群組內容）：\n" +
              result.groups
                .map(
                  (g) =>
                    `${g.name}：${this.groupState(g.state)}，有效資料 ${g.sourceCount}，保存失敗 ${g.failedCount}`,
                )
                .join("\n");
            if (result.usage)
              text +=
                "\n" +
                result.usage
                  .map(
                    (u) =>
                      `${u.month} ${u.provider}：已記帳 USD ${(Number(u.chargedMicros) / 1e6).toFixed(4)}；預留 USD ${(Number(u.reservedMicros) / 1e6).toFixed(4)}`,
                  )
                  .join("\n");
            actions = result.groups.map((g, i) => ({
              label: `${i + 1}. 管理選單`,
              data: `manage:select:${g.id}`,
            }));
            if (result.proposal) {
              const draft = result.proposal;
              text += "\n有一項管理草稿，尚未執行。";
              if (draft.action === "setup")
                text += "啟用、恢復與設定變更請回原群組 @Bot 設定。";
              else
                actions.push({
                  label: `預覽${draft.action === "pause" ? "暫停" : "刪除"}`,
                  data: `manage:${draft.action}:${draft.groupId}:${draft.revision}`,
                });
            }
          }
        }
      } else if (row.kind === "binding") {
        await this.ports.finalize(
          row.actor_id,
          payload.nonce!,
          payload.result!,
          row.event_id,
        );
        text = "LINE 綁定流程已處理。請返回設定頁接續；綁定不會自動啟用群組。";
      } else if (row.kind === "bootstrap") {
        const intent = await this.registration.begin(
          row.scope_id,
          row.actor_id,
          row,
        );
        text = `請由網站管理員開啟 ${this.ports.adminOrigin}/line-harness/setup#intent=${intent} 完成登入與 LINE 綁定，再回本群組確認。尚未開始收錄。`;
        actions = [{ label: "預覽群組設定", data: `setup:preview:${intent}` }];
      } else if (row.kind === "preview") {
        const preview = await this.registration.preview(
          payload.intent!,
          row.actor_id,
          row.scope_id,
          row,
        );
        text = preview.text;
        actions = [
          {
            label: "確認並公告",
            data: `setup:confirm:${payload.intent}:${preview.token}`,
          },
        ];
      } else if (row.kind === "confirm") {
        if (!row.delivery_id) throw new Error("reply_expired");
        await this.registration.confirm(
          payload.intent!,
          payload.token!,
          row.actor_id,
          row.scope_id,
          row.delivery_id,
          row,
        );
      } else {
        const a = await this.registration.ports.authority(row.actor_id);
        if (!a.bound)
          text = `帳號綁定：${await this.ports.binding(row.actor_id)}\n群組設定請回原群組 @Bot 啟用；私聊不提供群組內容。`;
        else if (!a.allowed)
          text = "私聊僅供目前網站全域管理員管理；請回群組使用群組服務。";
        else {
          const admin = await this.registration.admin(row.actor_id);
          const management = this.ports.management;
          if (!management) throw Error("management_unavailable");
          const action = row.kind === "management" ? payload.action : "page";
          if (action === "confirm") {
            await management.confirm(
              admin.actorUserId,
              payload.id!,
              payload.value!,
              row,
            );
            text = "管理操作已完成。";
          } else if (action === "pause" || action === "delete") {
            const p = await management.preview(
              admin.actorUserId,
              payload.id!,
              action,
              Number(payload.value),
              undefined,
              row,
            );
            text = p.text;
            actions = [
              { label: "確認執行", data: `manage:confirm:${p.id}:${p.token}` },
            ];
          } else if (action === "select") {
            const g = await management.group(admin.actorUserId, payload.id!);
            text = `${g.display_name}：${this.groupState(g.state)}。恢復、目的地或分享變更請回原群組 @Bot 設定。\n管理頁：${this.ports.adminOrigin}/line-harness`;
            if (!["deleting", "deleted"].includes(g.state))
              actions = [
                {
                  label: "預覽暫停",
                  data: `manage:pause:${g.id}:${g.revision}`,
                },
                {
                  label: "預覽刪除",
                  data: `manage:delete:${g.id}:${g.revision}`,
                },
              ];
          } else {
            const groups = await management.groups(
              admin.actorUserId,
              row.kind === "management" ? payload.id : "",
              5,
            );
            text =
              "群組管理（僅狀態，不提供內容或下載）：\n" +
              (groups
                .map(
                  (g) =>
                    `${g.display_name}：${this.groupState(g.state)}，有效資料 ${g.source_count}，保存失敗 ${g.failed_count}`,
                )
                .join("\n") || "尚無群組；請回目標群組 @Bot 啟用。");
            actions = groups.map((g, i) => ({
              label: `${i + 1}. ${g.display_name}`.slice(0, 20),
              data: `manage:select:${g.id}`,
            }));
            if (groups.length === 5)
              actions.push({
                label: "下一頁",
                data: `manage:page:${groups.at(-1)!.id}`,
              });
          }
        }
      }
      if (text && row.delivery_id) {
        await this.deliveries.prepare(row.delivery_id, text, actions);
        await beforeReply?.();
        await this.deliveries.deliver(row.delivery_id, this.ports.send);
      }
    } catch {
      state = "failed";
      if (row.delivery_id) {
        await this.deliveries.prepare(
          row.delivery_id,
          [
            "search",
            "search-get",
            "search-list",
            "conversation-reset",
            "source-preview",
            "source-confirm",
          ].includes(row.kind)
            ? "目前無法完成。請確認仍為原群組成員，或稍後重新查詢；資料異動請重新預覽。"
            : "目前無法完成。請確認登入、綁定與管理員資格，再回原群組重新預覽。",
        );
        await this.deliveries.deliver(row.delivery_id, this.ports.send);
      }
    }
    await this.store.pool.query(
      "UPDATE interactions SET state=$3,payload_ciphertext=NULL WHERE id=$1 AND fence=$2 AND state='running'",
      [row.id, row.fence, state],
    );
    return true;
  }
}
