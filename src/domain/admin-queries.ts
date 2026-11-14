import type { PoolClient } from "pg";
import type { Store, InteractionFence } from "../persistence/store.ts";
import type { HarnessAgent, AdminResult } from "../agent/agent.ts";
import type { Management } from "./management.ts";
import type { AdminAuthority } from "./registration.ts";
const IDLE = 30 * 60000;
interface Session {
  id: string;
  actor_id: string;
  last_result_id: string | null;
  generation: string;
  runtime_generation: string;
  last_interaction_at: Date;
}
interface Job {
  id: string;
  conversation_id: string;
  conversation_generation: string;
  runtime_generation: string;
  authority: Required<AdminAuthority>;
  state: string;
  query_ciphertext: string | null;
  result_ciphertext: string | null;
  expires_at: Date;
  lease_until: Date | null;
  fence: string;
}
const same = (a: AdminAuthority, b: AdminAuthority) =>
  a.actorUserId === b.actorUserId &&
  a.bindingGeneration === b.bindingGeneration &&
  a.adminAuthorizationRevision === b.adminAuthorizationRevision;
export class AdminQueries {
  readonly store: Store;
  readonly management: Management;
  readonly agent: Pick<HarnessAgent, "admin">;
  constructor(
    store: Store,
    management: Management,
    agent: Pick<HarnessAgent, "admin">,
  ) {
    this.store = store;
    this.management = management;
    this.agent = agent;
  }
  async clear(
    c: PoolClient,
    s: Session,
    preserveReady = false,
    fence?: InteractionFence,
  ) {
    await c.query(
      "UPDATE admin_conversations SET generation=generation+1,last_result_id=NULL,last_interaction_at=$2 WHERE id=$1",
      [s.id, this.store.now()],
    );
    await c.query(
      "UPDATE admin_queries SET state='cancelled',query_ciphertext=NULL,result_ciphertext=NULL,lease_until=NULL,fence=fence+1 WHERE conversation_id=$1 AND (NOT $2 OR state<>'ready')",
      [s.id, preserveReady],
    );
    await c.query(
      "UPDATE deliveries SET state='cancelled',token_ciphertext=NULL,body=NULL,actions=NULL WHERE admin_conversation_id=$1 AND state='pending' AND id IS DISTINCT FROM (SELECT delivery_id FROM interactions WHERE id=$2)",
      [s.id, fence?.id ?? null],
    );
  }
  async session(c: PoolClient, actor: string, fence?: InteractionFence) {
    const runtime = (await c.query("SELECT * FROM runtime_state FOR SHARE"))
      .rows[0];
    if (runtime.mode !== "open") throw new Error("admin_query_changed");
    await c.query(
      "INSERT INTO admin_conversations(channel_id,actor_id,runtime_generation,last_interaction_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [this.store.channelId, actor, runtime.generation, this.store.now()],
    );
    let s = (
      await c.query<Session>(
        "SELECT * FROM admin_conversations WHERE channel_id=$1 AND actor_id=$2 FOR UPDATE",
        [this.store.channelId, actor],
      )
    ).rows[0]!;
    await this.store.requireInteraction(c, fence);
    if (
      s.runtime_generation !== runtime.generation ||
      s.last_interaction_at.getTime() + IDLE <= this.store.now().getTime()
    ) {
      await this.clear(c, s, true, fence);
      s = (
        await c.query<Session>(
          "UPDATE admin_conversations SET runtime_generation=$2 WHERE id=$1 RETURNING *",
          [s.id, runtime.generation],
        )
      ).rows[0]!;
    }
    await c.query(
      "UPDATE admin_conversations SET last_interaction_at=$2 WHERE id=$1",
      [s.id, this.store.now()],
    );
    if (fence)
      await c.query(
        "UPDATE deliveries SET admin_conversation_id=$2,admin_conversation_generation=$3 WHERE id=(SELECT delivery_id FROM interactions WHERE id=$1)",
        [fence.id, s.id, s.generation],
      );
    return s;
  }
  async start(actor: string, query: string, fence?: InteractionFence) {
    if (!query.trim() || [...query].length > 200)
      throw new Error("invalid_agent_query");
    const authority = await this.management.registration.admin(actor);
    return this.store.transaction(async (c) => {
      const s = await this.session(c, actor, fence);
      if (
        Number(
          (
            await c.query(
              "SELECT count(*) n FROM admin_queries WHERE conversation_id=$1 AND state IN ('queued','running')",
              [s.id],
            )
          ).rows[0].n,
        ) >= 3
      )
        throw new Error("admin_query_busy");
      const row = (
        await c.query(
          "INSERT INTO admin_queries(conversation_id,conversation_generation,runtime_generation,authority,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
          [
            s.id,
            s.generation,
            s.runtime_generation,
            authority,
            this.store.now(),
            new Date(this.store.now().getTime() + IDLE),
          ],
        )
      ).rows[0];
      await c.query(
        "UPDATE admin_queries SET query_ciphertext=$2 WHERE id=$1",
        [row.id, this.store.cipher.sealPayload(query, `admin-query:${row.id}`)],
      );
      return { id: row.id as string };
    });
  }
  async reset(actor: string, fence?: InteractionFence) {
    await this.management.registration.admin(actor);
    await this.store.transaction(async (c) => {
      const s = await this.session(c, actor, fence);
      await this.clear(c, s, false, fence);
      if (fence)
        await c.query(
          "UPDATE deliveries SET admin_conversation_generation=$2::bigint+1 WHERE id=(SELECT delivery_id FROM interactions WHERE id=$1)",
          [fence.id, s.generation],
        );
    });
  }
  async valid(
    c: PoolClient,
    id: string,
    actor: string,
    authority: AdminAuthority,
    ready = true,
  ) {
    const runtime = (await c.query("SELECT * FROM runtime_state")).rows[0];
    const row = (
      await c.query<
        Job & {
          actor_id: string;
          channel_id: string;
          session_generation: string;
          session_runtime: string;
          last_interaction_at: Date;
        }
      >(
        `SELECT j.*,s.actor_id,s.channel_id,s.generation AS session_generation,s.runtime_generation AS session_runtime,s.last_interaction_at FROM admin_queries j JOIN admin_conversations s ON s.id=j.conversation_id WHERE j.id=$1`,
        [id],
      )
    ).rows[0];
    if (
      !row ||
      row.actor_id !== actor ||
      row.channel_id !== this.store.channelId
    )
      throw new Error("admin_query_forbidden");
    if (
      runtime.mode !== "open" ||
      runtime.generation !== row.runtime_generation ||
      row.session_runtime !== runtime.generation ||
      row.state === "cancelled" ||
      row.expires_at <= this.store.now() ||
      !same(row.authority, authority) ||
      (!(ready && row.state === "ready") &&
        (row.session_generation !== row.conversation_generation ||
          row.last_interaction_at.getTime() + IDLE <=
            this.store.now().getTime()))
    )
      throw new Error("admin_query_changed");
    return row;
  }
  async read(
    id: string,
    actor: string,
    fence?: InteractionFence,
  ): Promise<{ state: string; result?: AdminResult }> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("admin_query_forbidden");
    const authority = await this.management.registration.admin(actor);
    const row = await this.store.transaction((c) =>
      this.valid(c, id, actor, authority),
    );
    const result =
      row.state === "ready" && row.result_ciphertext
        ? (JSON.parse(
            this.store.cipher.openPayload(
              row.result_ciphertext,
              `admin-result:${id}`,
            ),
          ) as AdminResult)
        : undefined;
    if (result)
      for (const group of result.groups) {
        const current = await this.management.group(
          authority.actorUserId,
          group.id,
        );
        if (
          current.revision !== group.revision ||
          current.state !== group.state
        )
          throw new Error("admin_query_changed");
      }
    const current = await this.management.registration.admin(actor);
    if (!same(authority, current)) throw new Error("admin_query_changed");
    await this.store.transaction(async (c) => {
      if (fence) await this.session(c, actor, fence);
      await this.valid(c, id, actor, current);
      if (fence)
        await c.query(
          "UPDATE deliveries SET admin_query_id=$2 WHERE id=(SELECT delivery_id FROM interactions WHERE id=$1)",
          [fence.id, id],
        );
    });
    return { state: row.state, ...(result ? { result } : {}) };
  }
  async candidates(actor: string, before?: string) {
    const authority = await this.management.registration.admin(actor);
    if (before && !/^[0-9a-f-]{36}$/.test(before))
      throw new Error("admin_query_forbidden");
    let cursor: { created_at: Date; id: string } | undefined;
    if (before) {
      cursor = (
        await this.store.pool.query(
          "SELECT j.created_at,j.id FROM admin_queries j JOIN admin_conversations s ON s.id=j.conversation_id WHERE j.id=$1 AND s.actor_id=$2 AND s.channel_id=$3",
          [before, actor, this.store.channelId],
        )
      ).rows[0];
      if (!cursor) throw new Error("admin_query_forbidden");
    }
    const rows = (
      await this.store.pool.query(
        "SELECT j.id,j.created_at,j.state FROM admin_queries j JOIN admin_conversations s ON s.id=j.conversation_id CROSS JOIN runtime_state r WHERE s.actor_id=$1 AND s.channel_id=$2 AND j.expires_at>$3 AND j.state<>'cancelled' AND j.runtime_generation=r.generation AND r.mode='open' AND j.authority=$4::jsonb AND ($5::timestamptz IS NULL OR (j.created_at,j.id)<($5,$6::uuid)) ORDER BY j.created_at DESC,j.id DESC LIMIT 5",
        [
          actor,
          this.store.channelId,
          this.store.now(),
          authority,
          cursor?.created_at ?? null,
          cursor?.id ?? null,
        ],
      )
    ).rows as { id: string; created_at: Date; state: string }[];
    if (!same(authority, await this.management.registration.admin(actor)))
      throw new Error("admin_query_changed");
    return rows;
  }
  async processOne(): Promise<boolean> {
    const job = await this.store.transaction(async (c) => {
      await c.query(
        "UPDATE admin_queries j SET state='failed',query_ciphertext=NULL,lease_until=NULL,fence=fence+1 FROM admin_conversations s WHERE j.conversation_id=s.id AND s.channel_id=$1 AND ((j.state='running' AND j.lease_until<=$2) OR (j.state='queued' AND j.expires_at<=$2))",
        [this.store.channelId, this.store.now()],
      );
      const row = (
        await c.query<Job & { actor_id: string }>(
          `SELECT j.*,s.actor_id FROM admin_queries j JOIN admin_conversations s ON s.id=j.conversation_id CROSS JOIN runtime_state r WHERE s.channel_id=$1 AND r.mode='open' AND r.generation=j.runtime_generation AND s.generation=j.conversation_generation AND s.last_interaction_at>$2 AND j.state='queued' AND j.expires_at>$3 AND NOT EXISTS(SELECT 1 FROM admin_queries older WHERE older.conversation_id=j.conversation_id AND older.state IN ('queued','running') AND older.sequence<j.sequence) ORDER BY j.sequence FOR UPDATE OF j SKIP LOCKED LIMIT 1`,
          [
            this.store.channelId,
            new Date(this.store.now().getTime() - IDLE),
            this.store.now(),
          ],
        )
      ).rows[0];
      if (!row) return;
      const updated = (
        await c.query<Job>(
          "UPDATE admin_queries SET state='running',fence=fence+1,lease_until=$2 WHERE id=$1 RETURNING *",
          [row.id, new Date(this.store.now().getTime() + 60000)],
        )
      ).rows[0]!;
      return { ...updated, actor_id: row.actor_id };
    });
    if (!job) return false;
    try {
      const valid = async () => {
        const authority = await this.management.registration.admin(
          job.actor_id,
        );
        await this.store.transaction(async (c) => {
          const current = await this.valid(
            c,
            job.id,
            job.actor_id,
            authority,
            false,
          );
          if (
            current.state !== "running" ||
            current.fence !== job.fence ||
            !current.lease_until ||
            current.lease_until <= this.store.now()
          )
            throw new Error("admin_query_changed");
        });
      };
      await valid();
      const prior = (
        await this.store.pool.query<Session>(
          "SELECT * FROM admin_conversations WHERE id=$1",
          [job.conversation_id],
        )
      ).rows[0];
      let previous: AdminResult | undefined;
      if (prior?.last_result_id) {
        try {
          previous = (await this.read(prior.last_result_id, job.actor_id))
            .result;
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.message !== "admin_query_changed"
          )
            throw error;
        }
      }
      const result = await this.agent.admin(
        job.id,
        job.actor_id,
        this.store.cipher.openPayload(
          job.query_ciphertext!,
          `admin-query:${job.id}`,
        ),
        this.management,
        valid,
        previous,
      );
      await valid();
      await this.store.transaction(async (c) => {
        const runtime = (await c.query("SELECT * FROM runtime_state FOR SHARE"))
          .rows[0];
        const session = (
          await c.query<Session>(
            "SELECT * FROM admin_conversations WHERE id=$1 FOR SHARE",
            [job.conversation_id],
          )
        ).rows[0]!;
        if (
          runtime.mode !== "open" ||
          runtime.generation !== job.runtime_generation ||
          session.generation !== job.conversation_generation
        )
          throw new Error("admin_query_changed");
        const changed = await c.query(
          "UPDATE admin_queries SET state='ready',query_ciphertext=NULL,result_ciphertext=$3,expires_at=$4,lease_until=NULL WHERE id=$1 AND fence=$2 AND state='running' AND lease_until>$5",
          [
            job.id,
            job.fence,
            this.store.cipher.sealPayload(
              JSON.stringify(result),
              `admin-result:${job.id}`,
            ),
            new Date(this.store.now().getTime() + 86400000),
            this.store.now(),
          ],
        );
        if (!changed.rowCount) throw new Error("admin_query_changed");
        await c.query(
          "UPDATE admin_conversations SET last_result_id=$2 WHERE id=$1",
          [job.conversation_id, job.id],
        );
        await c.query(
          "UPDATE model_runs SET state='completed' WHERE id=$1 AND state='running'",
          [job.id],
        );
      });
    } catch {
      await this.store.pool.query(
        "UPDATE admin_queries SET state='failed',query_ciphertext=NULL,result_ciphertext=NULL,lease_until=NULL WHERE id=$1 AND fence=$2 AND state='running'",
        [job.id, job.fence],
      );
    }
    return true;
  }
}
