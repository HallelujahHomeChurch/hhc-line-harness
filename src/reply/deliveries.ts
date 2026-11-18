import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  liveTurnDependencies,
  closeGroupTurns,
  type PublicTurnDraft,
} from "../domain/group-turns.ts";
import type { ReplyReceipt, ReplyAction } from "../providers/line.ts";
import type { Store } from "../persistence/store.ts";

export class Deliveries {
  readonly store: Store;
  constructor(store: Store) {
    this.store = store;
  }
  async create(
    client: PoolClient,
    input: {
      eventId: string;
      token: string;
      publishedAt: Date;
      groupId?: string;
      groupRevision?: string;
      actorId?: string;
      scopeId?: string;
    },
  ): Promise<string | undefined> {
    const now = this.store.now();
    if (
      input.publishedAt.getTime() < now.getTime() - 45_000 ||
      input.publishedAt > now
    )
      return;
    const id = randomUUID();
    const row = await client.query(
      `INSERT INTO deliveries(id,channel_id,event_id,group_id,group_revision,runtime_generation,token_ciphertext,received_at,expires_at,actor_id,scope_id)
      SELECT $1,$2,$3,$4,$5,generation,$6,$7,$8,$9,$10 FROM runtime_state WHERE mode='open'
      ON CONFLICT DO NOTHING RETURNING id`,
      [
        id,
        this.store.channelId,
        input.eventId,
        input.groupId,
        input.groupRevision,
        this.store.cipher.seal(input.token, id),
        now,
        new Date(input.publishedAt.getTime() + 45_000),
        input.actorId,
        input.scopeId,
      ],
    );
    return row.rows[0]?.id;
  }
  async prepare(
    id: string,
    text: string,
    actions?: ReplyAction[],
    options?: { publicTurn?: PublicTurnDraft; quoteToken?: string },
  ): Promise<void> {
    if (!text.trim() || text.length > 5000) throw new Error("invalid_reply");
    await this.store.pool.query(
      "UPDATE deliveries SET body=$2,actions=$4,turn_ciphertext=$5,quote_token_ciphertext=$6 WHERE id=$1 AND state='pending' AND expires_at>$3 AND body IS NULL",
      [
        id,
        text,
        this.store.now(),
        actions ? JSON.stringify(actions) : null,
        options?.publicTurn
          ? this.store.cipher.sealPayload(
              JSON.stringify({ ...options.publicTurn, answer: text }),
              `delivery-turn:${id}`,
            )
          : null,
        options?.quoteToken
          ? this.store.cipher.sealPayload(
              options.quoteToken,
              `delivery-quote:${id}`,
            )
          : null,
      ],
    );
  }
  async reserve(id: string): Promise<
    | {
        token: string;
        text: string;
        actions?: ReplyAction[];
        publicTurn?: PublicTurnDraft;
        quoteToken?: string;
      }
    | undefined
  > {
    return this.store.transaction(async (client) => {
      const runtime = (
        await client.query("SELECT * FROM runtime_state FOR SHARE")
      ).rows[0];
      // Lock group before delivery, matching intake and management lock order.
      const identity = (
        await client.query(
          "SELECT group_id,search_result_id FROM deliveries WHERE id=$1",
          [id],
        )
      ).rows[0];
      const group = identity?.group_id
        ? (
            await client.query("SELECT * FROM groups WHERE id=$1 FOR SHARE", [
              identity.group_id,
            ])
          ).rows[0]
        : undefined;
      const resultSnapshot = identity?.search_result_id
        ? (
            await client.query("SELECT * FROM search_jobs WHERE id=$1", [
              identity.search_result_id,
            ])
          ).rows[0]
        : undefined;
      const liveResultSources = resultSnapshot?.source_ids.length
        ? (
            await client.query(
              "SELECT id FROM sources WHERE id=ANY($1::uuid[]) AND state NOT IN ('revoked','expired','failed') AND expires_at>$2 ORDER BY id FOR SHARE",
              [resultSnapshot.source_ids, this.store.now()],
            )
          ).rows
        : [];
      const sessionIdentity = (
        await client.query(
          "SELECT conversation_id FROM deliveries WHERE id=$1",
          [id],
        )
      ).rows[0];
      const session = sessionIdentity?.conversation_id
        ? (
            await client.query(
              "SELECT * FROM conversations WHERE id=$1 FOR SHARE",
              [sessionIdentity.conversation_id],
            )
          ).rows[0]
        : undefined;
      const result = identity?.search_result_id
        ? (
            await client.query(
              "SELECT * FROM search_jobs WHERE id=$1 FOR SHARE",
              [identity.search_result_id],
            )
          ).rows[0]
        : undefined;
      const adminIdentity = (
        await client.query(
          "SELECT admin_conversation_id,admin_query_id FROM deliveries WHERE id=$1",
          [id],
        )
      ).rows[0];
      const adminSession = adminIdentity?.admin_conversation_id
        ? (
            await client.query(
              "SELECT * FROM admin_conversations WHERE id=$1 FOR SHARE",
              [adminIdentity.admin_conversation_id],
            )
          ).rows[0]
        : undefined;
      const adminResult = adminIdentity?.admin_query_id
        ? (
            await client.query(
              "SELECT * FROM admin_queries WHERE id=$1 FOR SHARE",
              [adminIdentity.admin_query_id],
            )
          ).rows[0]
        : undefined;
      const interaction = (
        await client.query(
          "SELECT state,lease_until FROM interactions WHERE delivery_id=$1 FOR SHARE",
          [id],
        )
      ).rows[0];
      const row = (
        await client.query("SELECT * FROM deliveries WHERE id=$1 FOR UPDATE", [
          id,
        ])
      ).rows[0];
      if (!row || row.state !== "pending") return;
      const now = this.store.now();
      const state =
        row.expires_at <= now
          ? "expired"
          : !runtime ||
              runtime.mode !== "open" ||
              (interaction &&
                (interaction.state !== "running" ||
                  interaction.lease_until <= now)) ||
              row.runtime_generation !== runtime.generation ||
              (row.admin_conversation_id &&
                (!adminSession ||
                  adminSession.generation !==
                    row.admin_conversation_generation ||
                  adminSession.runtime_generation !== runtime.generation ||
                  adminSession.last_interaction_at.getTime() + 30 * 60000 <=
                    now.getTime())) ||
              (row.admin_query_id &&
                (!adminResult ||
                  adminResult.state === "cancelled" ||
                  adminResult.expires_at <= now ||
                  adminResult.runtime_generation !== runtime.generation ||
                  adminResult.conversation_id !== row.admin_conversation_id)) ||
              (row.search_result_id &&
                (!result ||
                  result.state === "cancelled" ||
                  result.expires_at <= now ||
                  result.runtime_generation !== runtime.generation ||
                  result.conversation_id !== row.conversation_id ||
                  liveResultSources.length !== result.source_ids.length ||
                  result.source_ids.some(
                    (sourceId: string) =>
                      !liveResultSources.some(
                        (source) => source.id === sourceId,
                      ),
                  ))) ||
              (row.conversation_id &&
                (!session ||
                  session.generation !== row.conversation_generation ||
                  session.last_interaction_at.getTime() + 30 * 60_000 <=
                    now.getTime())) ||
              (row.group_id &&
                (!group ||
                  group.revision !== row.group_revision ||
                  ["left", "deleting", "deleted"].includes(group.state)))
            ? "cancelled"
            : undefined;
      if (state) {
        await client.query(
          "UPDATE deliveries SET state=$2,token_ciphertext=NULL,body=NULL,actions=NULL,finished_at=$3 WHERE id=$1",
          [id, state, now],
        );
        return;
      }
      if (!row.body) return;
      const publicTurn = row.turn_ciphertext
        ? (JSON.parse(
            this.store.cipher.openPayload(
              row.turn_ciphertext,
              `delivery-turn:${id}`,
            ),
          ) as PublicTurnDraft)
        : undefined;
      if (
        publicTurn &&
        (group?.state !== "active" ||
          !(await liveTurnDependencies(
            client,
            publicTurn.dependencies,
            row.group_id,
            now,
          )))
      ) {
        await client.query(
          "UPDATE deliveries SET state='cancelled',body=NULL,actions=NULL,token_ciphertext=NULL,turn_ciphertext=NULL,quote_token_ciphertext=NULL WHERE id=$1",
          [id],
        );
        return;
      }
      if (publicTurn?.parent) {
        const parent = (
          await client.query(
            "SELECT * FROM group_turns WHERE id=$1 AND group_id=$2 FOR UPDATE",
            [publicTurn.parent.id, row.group_id],
          )
        ).rows[0];
        const oldClaim = parent?.claimed_by
          ? (
              await client.query("SELECT state FROM deliveries WHERE id=$1", [
                parent.claimed_by,
              ])
            ).rows[0]
          : undefined;
        if (
          !parent ||
          parent.actor_id !== row.actor_id ||
          parent.version !== publicTurn.parent.version ||
          parent.follow_up !== "awaiting" ||
          parent.consumed_by ||
          !parent.answer_ciphertext ||
          (oldClaim && ["pending", "attempt_reserved"].includes(oldClaim.state))
        ) {
          await client.query(
            "UPDATE deliveries SET state='cancelled',body=NULL,actions=NULL,token_ciphertext=NULL,turn_ciphertext=NULL,quote_token_ciphertext=NULL WHERE id=$1",
            [id],
          );
          return;
        }
        await client.query("UPDATE group_turns SET claimed_by=$2 WHERE id=$1", [
          parent.id,
          id,
        ]);
      }
      const token = this.store.cipher.open(row.token_ciphertext, id);
      const quoteToken = row.quote_token_ciphertext
        ? this.store.cipher.openPayload(
            row.quote_token_ciphertext,
            `delivery-quote:${id}`,
          )
        : undefined;
      await client.query(
        "UPDATE deliveries SET state='attempt_reserved',attempted_at=$2,token_ciphertext=NULL,body=NULL,actions=NULL WHERE id=$1",
        [id, now],
      );
      return {
        token,
        text: row.body,
        actions: row.actions ?? undefined,
        publicTurn,
        quoteToken,
      };
    });
  }
  async deliver(
    id: string,
    send: (
      token: string,
      text: string,
      actions?: ReplyAction[],
      options?: { quoteToken?: string },
    ) => Promise<ReplyReceipt | void>,
  ): Promise<"delivered" | "unknown" | undefined> {
    const attempt = await this.reserve(id);
    if (!attempt) return;
    let state: "delivered" | "unknown" = "unknown";
    let receipt: ReplyReceipt | void;
    try {
      receipt = await send(attempt.token, attempt.text, attempt.actions, {
        quoteToken: attempt.quoteToken,
      });
      const ids = receipt?.messageIds;
      if (
        !attempt.publicTurn ||
        (ids?.length &&
          ids.length <= 5 &&
          new Set(ids).size === ids.length &&
          ids.every((id) => /^[A-Za-z0-9_-]{1,128}$/.test(id)))
      )
        state = "delivered";
    } catch {
      /* Ambiguous sends never retry. */
    }
    try {
      return await this.store.transaction(async (c) => {
        const runtime = (await c.query("SELECT * FROM runtime_state FOR SHARE"))
          .rows[0];
        const identity = (
          await c.query("SELECT group_id FROM deliveries WHERE id=$1", [id])
        ).rows[0];
        const group = identity?.group_id
          ? (
              await c.query("SELECT * FROM groups WHERE id=$1 FOR SHARE", [
                identity.group_id,
              ])
            ).rows[0]
          : undefined;
        const draft = attempt.publicTurn;
        const live =
          draft &&
          group?.state === "active" &&
          (await liveTurnDependencies(
            c,
            draft.dependencies,
            group.id,
            this.store.now(),
          ));
        const row = (
          await c.query(
            "UPDATE deliveries SET state=$2,finished_at=$3,turn_ciphertext=NULL,quote_token_ciphertext=NULL WHERE id=$1 AND state='attempt_reserved' RETURNING *",
            [id, state, this.store.now()],
          )
        ).rows[0];
        if (!row) return undefined;
        const parent = draft?.parent
          ? (
              await c.query(
                "SELECT * FROM group_turns WHERE id=$1 FOR UPDATE",
                [draft.parent.id],
              )
            ).rows[0]
          : undefined;
        const parentValid =
          !draft?.parent ||
          (parent?.claimed_by === id &&
            parent.version === draft.parent.version &&
            !parent.consumed_by);
        if (
          parentValid &&
          state === "delivered" &&
          draft &&
          live &&
          runtime.mode === "open" &&
          row.runtime_generation === runtime.generation &&
          row.group_revision === group.revision
        ) {
          if (draft.parent)
            await c.query(
              "UPDATE group_turns SET consumed_by=$2,claimed_by=NULL WHERE id=$1 AND claimed_by=$2",
              [draft.parent.id, id],
            );
          if (draft.followUp === "closed")
            await closeGroupTurns(
              c,
              row.group_id,
              row.actor_id,
              new Date(draft.publishedAt),
              row.event_id,
            );
          const expires = new Date(
            Math.min(
              new Date(draft.publishedAt).getTime() + 90 * 86400000,
              ...draft.dependencies.map((d) => Date.parse(d.expiresAt)),
            ),
          );
          await c.query(
            `INSERT INTO group_turns(id,group_id,actor_id,group_revision,runtime_generation,message_id,event_at,delivered_at,line_message_ids,question_ciphertext,answer_ciphertext,kind,follow_up,dependencies,source_ids,expires_at,event_id)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
            [
              id,
              row.group_id,
              row.actor_id,
              row.group_revision,
              row.runtime_generation,
              draft.messageId,
              draft.publishedAt,
              this.store.now(),
              receipt!.messageIds,
              this.store.cipher.sealPayload(
                draft.question,
                `turn-question:${id}`,
              ),
              this.store.cipher.sealPayload(attempt.text, `turn-answer:${id}`),
              draft.kind,
              draft.followUp,
              JSON.stringify(draft.dependencies),
              draft.dependencies.map((d) => d.id),
              expires,
              row.event_id,
            ],
          );
        }
        if (draft?.parent)
          await c.query(
            "UPDATE group_turns SET claimed_by=NULL WHERE id=$1 AND claimed_by=$2",
            [draft.parent.id, id],
          );
        return state;
      });
    } catch {
      // COMMIT may have succeeded. Read proof on a fresh connection, never send again.
      const row = (
        await this.store.pool.query(
          "SELECT state FROM deliveries WHERE id=$1",
          [id],
        )
      ).rows[0];
      if (row?.state === "delivered" || row?.state === "unknown")
        return row.state as "delivered" | "unknown";
      await this.store.pool.query(
        "UPDATE deliveries SET state='unknown',turn_ciphertext=NULL,quote_token_ciphertext=NULL,finished_at=$2 WHERE id=$1 AND state='attempt_reserved'",
        [id, this.store.now()],
      );
      return "unknown";
    }
  }
}
