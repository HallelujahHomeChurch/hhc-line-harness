import type { Pool, PoolClient } from "pg";
import { applyLifecycle, sourceKey } from "../domain/lifecycle.ts";
import type { LineEvent } from "../domain/events.ts";
import type { ReplyTokenCipher } from "../reply/token.ts";

export interface InteractionFence {
  id: string;
  fence: string;
}
export interface IntakeGroup {
  id: string;
  revision: string;
  state: string;
  active_from: Date | null;
  sharing_enabled: boolean;
  collection_id: string | null;
  acl_revision: string | null;
  binding_generation: string | null;
}
const DAY = 86_400_000;
export class Store {
  readonly pool: Pool;
  private readonly replyCipher: ReplyTokenCipher | undefined;
  get cipher(): ReplyTokenCipher {
    if (!this.replyCipher) throw new Error("reply_not_available_in_worker");
    return this.replyCipher;
  }
  readonly channelId: string;
  readonly now: () => Date;
  constructor(
    pool: Pool,
    cipher: ReplyTokenCipher | undefined,
    channelId: string,
    now = () => new Date(),
  ) {
    this.pool = pool;
    this.replyCipher = cipher;
    this.channelId = channelId;
    this.now = now;
  }
  async transaction<T>(
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async requireInteraction(
    client: PoolClient,
    fence?: InteractionFence,
  ): Promise<void> {
    if (!fence) return;
    const row = await client.query(
      "SELECT id FROM interactions WHERE id=$1 AND fence=$2 AND state='running' AND lease_until>$3 FOR SHARE",
      [fence.id, fence.fence, this.now()],
    );
    if (!row.rowCount) throw new Error("interaction_expired");
  }
  async ingest(
    event: LineEvent,
    recordInteraction?: (
      client: PoolClient,
      event: LineEvent,
      group?: IntakeGroup,
    ) => Promise<void>,
  ): Promise<void> {
    await this.transaction(async (client) => {
      const now = this.now();
      const runtime = (
        await client.query("SELECT * FROM runtime_state FOR SHARE")
      ).rows[0];
      const denial =
        event.scope === "group" &&
        ["unsend", "leave", "memberLeft"].includes(event.type);
      if (
        !runtime ||
        runtime.mode === "restoring" ||
        (runtime.mode !== "open" && !denial)
      )
        throw new Error("intake_closed");
      // Receipts outlive the accepted event window; restore fencing also rejects old input.
      const receipt = await client.query(
        `INSERT INTO event_receipts(channel_id,event_id,scope,event_type,published_at,received_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING event_id`,
        [
          this.channelId,
          event.id,
          event.scope,
          event.type,
          event.publishedAt,
          now,
          new Date(now.getTime() + 7 * DAY),
        ],
      );
      if (!receipt.rowCount) return;
      if (await applyLifecycle(client, this.channelId, event, now)) return;
      if (
        event.publishedAt < runtime.ingest_floor ||
        event.publishedAt.getTime() < now.getTime() - DAY ||
        event.publishedAt > now
      )
        return;
      if (event.scope !== "group") {
        await recordInteraction?.(client, event);
        return;
      }
      const group = (
        await client.query<IntakeGroup>(
          "SELECT * FROM groups WHERE channel_id=$1 AND line_group_id=$2 FOR UPDATE",
          [this.channelId, event.scopeId],
        )
      ).rows[0];
      await recordInteraction?.(client, event, group);
      if (
        !group ||
        group.state !== "active" ||
        !group.active_from ||
        event.publishedAt < group.active_from
      )
        return;
      if (
        event.type !== "message" ||
        !event.message ||
        event.message.type === "unsupported"
      )
        return;
      const message = event.message;
      if (
        (
          await client.query(
            "SELECT 1 FROM source_tombstones WHERE source_key=$1",
            [sourceKey(this.channelId, event.scopeId, message.id)],
          )
        ).rowCount
      )
        return;
      const source = await client.query(
        `INSERT INTO sources(group_id,message_id,author_id,kind,body,file_name,byte_size,published_at,expires_at,state,publication_collection_id,publication_acl_revision,publication_binding_generation)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING RETURNING id,revision`,
        [
          group.id,
          message.id,
          event.actorId,
          message.type,
          message.text,
          message.fileName,
          message.size,
          event.publishedAt,
          new Date(event.publishedAt.getTime() + 90 * DAY),
          message.type === "text" ? "ready" : "queued",
          group.sharing_enabled ? group.collection_id : null,
          group.sharing_enabled ? group.acl_revision : null,
          group.sharing_enabled ? group.binding_generation : null,
        ],
      );
      if (source.rowCount && message.quotedMessageId) {
        await client.query(
          `INSERT INTO source_relations(source_id,related_source_id,kind,evidence_source_id) SELECT $1,id,'quoted',$1 FROM sources WHERE group_id=$2 AND message_id=$3 AND state NOT IN ('revoked','expired','failed') AND expires_at>$4 ON CONFLICT DO NOTHING`,
          [source.rows[0].id, group.id, message.quotedMessageId, now],
        );
      }
      if (source.rowCount) {
        const job = (
          await client.query(
            `INSERT INTO jobs(source_id,kind,runtime_generation,source_revision,created_at,available_at,deadline)
          VALUES($1,$2,$3,$4,$5,$5,$6) RETURNING id`,
            [
              source.rows[0].id,
              message.type === "text" ? "index" : "download",
              runtime.generation,
              source.rows[0].revision,
              now,
              message.type === "text"
                ? null
                : new Date(now.getTime() + 15 * 60_000),
            ],
          )
        ).rows[0];
        await client.query(
          "INSERT INTO job_wakes(job_id,created_at) VALUES($1,$2)",
          [job.id, now],
        );
      }
      await client.query(
        "UPDATE event_receipts SET outcome='accepted' WHERE channel_id=$1 AND event_id=$2",
        [this.channelId, event.id],
      );
    });
  }
}

export async function requireRuntimeGeneration(pool: Pool, expected: string) {
  if (
    !/^[1-9][0-9]{0,18}$/.test(expected) ||
    BigInt(expected) > 9223372036854775807n
  )
    throw new Error("invalid_runtime_generation");
  const row = (await pool.query("SELECT generation FROM runtime_state"))
    .rows[0];
  if (row?.generation !== expected)
    throw new Error("runtime_generation_mismatch");
}
