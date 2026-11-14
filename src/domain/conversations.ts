import { z } from "zod";
import type { HarnessAgent } from "../agent/agent.ts";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { Store, InteractionFence } from "../persistence/store.ts";
import type { Search, SearchInput, SearchResult } from "../search/search.ts";
const IDLE = 30 * 60_000;
const resourceContext = z
  .object({
    kind: z.literal("resource_context_v1"),
    sourceIds: z.array(z.string().uuid()).max(5),
  })
  .strict();
interface Session {
  id: string;
  group_id: string;
  actor_id: string;
  generation: string;
  runtime_generation: string;
  last_interaction_at: Date;
}
interface QueryJob {
  use_agent: boolean;
  id: string;
  conversation_id: string;
  conversation_generation: string;
  runtime_generation: string;
  request_ciphertext: string | null;
  result_ciphertext: string | null;
  source_ids: string[];
  excluded_source_id: string | null;
  state: string;
  expires_at: Date;
  lease_until: Date | null;
  fence: string;
  attempts: number;
}
export class Conversations {
  readonly store: Store;
  readonly search: Search;
  readonly agent?: Pick<HarnessAgent, "query">;
  constructor(
    store: Store,
    search: Search,
    agent?: Pick<HarnessAgent, "query">,
  ) {
    this.agent = agent;
    this.store = store;
    this.search = search;
  }
  async clear(
    c: PoolClient,
    session: Session,
    exceptInteraction?: string,
    preserveReady = false,
  ) {
    await c.query(
      "UPDATE source_edits SET state='cancelled',text_ciphertext=NULL WHERE conversation_id=$1 AND state='preview'",
      [session.id],
    );
    await c.query(
      "UPDATE conversations SET generation=generation+1,checkpoint_ciphertext=NULL,checkpoint_sources='{}',last_interaction_at=$2 WHERE id=$1",
      [session.id, this.store.now()],
    );
    await c.query(
      "UPDATE search_jobs SET state='cancelled',fence=fence+1,request_ciphertext=NULL,result_ciphertext=NULL,source_ids='{}',lease_until=NULL WHERE conversation_id=$1 AND (NOT $2 OR state<>'ready')",
      [session.id, preserveReady],
    );
    await c.query(
      `UPDATE interactions SET state='failed',fence=fence+1,payload_ciphertext=NULL WHERE actor_id=$1 AND scope_id=(SELECT line_group_id FROM groups WHERE id=$2) AND channel_id=$3 AND state IN ('queued','running') AND id IS DISTINCT FROM $4::uuid`,
      [
        session.actor_id,
        session.group_id,
        this.store.channelId,
        exceptInteraction ?? null,
      ],
    );
    await c.query(
      "UPDATE deliveries SET state='cancelled',token_ciphertext=NULL,body=NULL,actions=NULL WHERE conversation_id=$1 AND state='pending' AND id IS DISTINCT FROM (SELECT delivery_id FROM interactions WHERE id=$2)",
      [session.id, exceptInteraction ?? null],
    );
  }
  async session(
    c: PoolClient,
    groupId: string,
    actor: string,
    generation: string,
    fence?: InteractionFence,
  ): Promise<Session> {
    const runtime = (await c.query("SELECT * FROM runtime_state FOR SHARE"))
      .rows[0];
    const group = (
      await c.query("SELECT * FROM groups WHERE id=$1 FOR SHARE", [groupId])
    ).rows[0];
    if (
      runtime?.mode !== "open" ||
      runtime.generation !== generation ||
      group?.state !== "active" ||
      group.channel_id !== this.store.channelId
    )
      throw new Error("search_unavailable");
    await c.query(
      "INSERT INTO conversations(group_id,actor_id,runtime_generation,last_interaction_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [groupId, actor, generation, this.store.now()],
    );
    let session = (
      await c.query<Session>(
        "SELECT * FROM conversations WHERE group_id=$1 AND actor_id=$2 FOR UPDATE",
        [groupId, actor],
      )
    ).rows[0]!;
    await this.store.requireInteraction(c, fence);
    if (
      session.runtime_generation !== generation ||
      session.last_interaction_at.getTime() + IDLE <= this.store.now().getTime()
    ) {
      await this.clear(c, session, fence?.id, true);
      session = (
        await c.query<Session>(
          "UPDATE conversations SET runtime_generation=$2 WHERE id=$1 RETURNING *",
          [session.id, generation],
        )
      ).rows[0]!;
    }
    await c.query(
      "UPDATE conversations SET last_interaction_at=$2 WHERE id=$1",
      [session.id, this.store.now()],
    );
    if (fence) {
      await c.query(
        "UPDATE interactions SET conversation_id=$2,conversation_generation=$3 WHERE id=$1",
        [fence.id, session.id, session.generation],
      );
      await c.query(
        "UPDATE deliveries SET conversation_id=$2,conversation_generation=$3 WHERE id=(SELECT delivery_id FROM interactions WHERE id=$1)",
        [fence.id, session.id, session.generation],
      );
    }
    return session;
  }
  async start(
    groupId: string,
    actor: string,
    input: SearchInput,
    fence?: InteractionFence,
    excludedSourceId?: string,
    useAgent = false,
  ) {
    this.search.validate(input);
    const scope = await this.search.scope(groupId, actor);
    return this.store.transaction(async (c) => {
      const session = await this.session(
        c,
        groupId,
        actor,
        scope.generation,
        fence,
      );
      if (
        excludedSourceId &&
        !(
          await c.query(
            "SELECT id FROM sources WHERE id=$1 AND group_id=$2 AND author_id=$3",
            [excludedSourceId, groupId, actor],
          )
        ).rowCount
      )
        throw new Error("invalid_search");
      const id = randomUUID();
      if (
        Number(
          (
            await c.query(
              "SELECT count(*) FROM search_jobs WHERE conversation_id=$1 AND state IN ('queued','running')",
              [session.id],
            )
          ).rows[0].count,
        ) >= 3
      )
        throw new Error("search_busy");
      await c.query(
        `INSERT INTO search_jobs(id,conversation_id,conversation_generation,runtime_generation,request_ciphertext,created_at,expires_at,excluded_source_id,use_agent)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          id,
          session.id,
          session.generation,
          scope.generation,
          this.store.cipher.sealPayload(
            JSON.stringify(input),
            `search-request:${id}`,
          ),
          this.store.now(),
          new Date(this.store.now().getTime() + IDLE),
          excludedSourceId ?? null,
          useAgent && Boolean(this.agent),
        ],
      );
      return { id, generation: session.generation };
    });
  }
  async reset(groupId: string, actor: string, fence?: InteractionFence) {
    const scope = await this.search.scope(groupId, actor);
    await this.store.transaction(async (c) => {
      const session = await this.session(
        c,
        groupId,
        actor,
        scope.generation,
        fence,
      );
      await this.clear(c, session, fence?.id);
      // The reset acknowledgement belongs to the new generation.
      if (fence) {
        await c.query(
          "UPDATE interactions SET conversation_generation=$2::bigint+1 WHERE id=$1",
          [fence.id, session.generation],
        );
        await c.query(
          "UPDATE deliveries SET conversation_generation=$2::bigint+1 WHERE id=(SELECT delivery_id FROM interactions WHERE id=$1)",
          [fence.id, session.generation],
        );
      }
    });
  }
  async valid(
    c: PoolClient,
    job: QueryJob,
    actor?: string,
    allowReady = false,
  ) {
    const session = (
      await c.query<Session>(
        "SELECT * FROM conversations WHERE id=$1 FOR SHARE",
        [job.conversation_id],
      )
    ).rows[0];
    const runtime = (await c.query("SELECT * FROM runtime_state")).rows[0];
    if (actor !== undefined && session?.actor_id !== actor)
      throw new Error("search_forbidden");
    if (
      !session ||
      runtime.mode !== "open" ||
      runtime.generation !== job.runtime_generation ||
      session.runtime_generation !== job.runtime_generation ||
      (!(allowReady && job.state === "ready") &&
        (session.generation !== job.conversation_generation ||
          session.last_interaction_at.getTime() + IDLE <=
            this.store.now().getTime())) ||
      job.expires_at <= this.store.now() ||
      job.state === "cancelled"
    )
      throw new Error("search_gone");
    return session;
  }
  async candidates(
    groupId: string,
    actor: string,
    before?: string,
  ): Promise<{ id: string; state: string; created_at: Date }[]> {
    const scope = await this.search.scope(groupId, actor);
    let cursor: { created_at: Date; id: string } | undefined;
    if (before) {
      if (!/^[0-9a-f-]{36}$/.test(before)) throw new Error("search_forbidden");
      cursor = (
        await this.store.pool.query(
          `SELECT j.id,j.created_at FROM search_jobs j JOIN conversations s ON s.id=j.conversation_id WHERE j.id=$1 AND s.group_id=$2 AND s.actor_id=$3`,
          [before, groupId, actor],
        )
      ).rows[0];
      if (!cursor) throw new Error("search_forbidden");
    }
    const rows = (
      await this.store.pool.query(
        `SELECT j.id,j.state,j.created_at FROM search_jobs j JOIN conversations s ON s.id=j.conversation_id WHERE s.group_id=$1 AND s.actor_id=$2 AND j.state<>'cancelled' AND j.expires_at>$3 AND j.runtime_generation=$6 AND s.runtime_generation=$6 AND ($4::timestamptz IS NULL OR (j.created_at,j.id)<($4,$5::uuid)) ORDER BY j.created_at DESC,j.id DESC LIMIT 5`,
        [
          groupId,
          actor,
          this.store.now(),
          cursor?.created_at ?? null,
          cursor?.id ?? null,
          scope.generation,
        ],
      )
    ).rows;
    const current = await this.search.scope(groupId, actor);
    if (
      current.revision !== scope.revision ||
      current.generation !== scope.generation
    )
      throw new Error("search_unavailable");
    return rows;
  }
  async read(
    id: string,
    actor: string,
    groupId?: string,
    fence?: InteractionFence,
  ): Promise<{ state: string; result?: SearchResult }> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("search_forbidden");
    const initial = await this.store.transaction(async (c) => {
      const job = (
        await c.query<QueryJob>("SELECT * FROM search_jobs WHERE id=$1", [id])
      ).rows[0];
      if (!job) throw new Error("search_forbidden");
      return { job, session: await this.valid(c, job, actor, true) };
    });
    if (groupId !== undefined && initial.session.group_id !== groupId)
      throw new Error("search_forbidden");
    const scope = await this.search.scope(initial.session.group_id, actor);
    return this.store.transaction(async (c) => {
      const lockedGroup = (
        await c.query(
          "SELECT state,revision FROM groups WHERE id=$1 FOR SHARE",
          [initial.session.group_id],
        )
      ).rows[0];
      if (
        lockedGroup.state !== "active" ||
        lockedGroup.revision !== scope.revision
      )
        throw new Error("search_unavailable");
      if (fence)
        await this.session(
          c,
          initial.session.group_id,
          actor,
          scope.generation,
          fence,
        );
      const job = (
        await c.query<QueryJob>("SELECT * FROM search_jobs WHERE id=$1", [id])
      ).rows[0]!;
      const group = (
        await c.query("SELECT state FROM groups WHERE id=$1 FOR SHARE", [
          initial.session.group_id,
        ])
      ).rows[0];
      if (group.state !== "active") throw new Error("search_paused");
      if (job.source_ids.length) {
        const live = await c.query(
          "SELECT id FROM sources WHERE id=ANY($1::uuid[]) AND state NOT IN ('revoked','expired','failed') AND expires_at>$2 FOR SHARE",
          [job.source_ids, this.store.now()],
        );
        if (live.rowCount !== job.source_ids.length)
          throw new Error("search_gone");
      }
      await this.valid(c, job, actor, true);
      if (fence)
        await c.query(
          "UPDATE deliveries SET search_result_id=$2 WHERE id=(SELECT delivery_id FROM interactions WHERE id=$1)",
          [fence.id, job.id],
        );
      return {
        state: job.state,
        ...(job.state === "ready" && job.result_ciphertext
          ? {
              result: JSON.parse(
                this.store.cipher.openPayload(
                  job.result_ciphertext,
                  `search-result:${job.id}`,
                ),
              ) as SearchResult,
            }
          : {}),
      };
    });
  }
  async saveCheckpoint(
    groupId: string,
    actor: string,
    generation: string,
    value: unknown,
    sourceIds: string[],
  ) {
    const encoded = JSON.stringify(value);
    if (
      !encoded ||
      Buffer.byteLength(encoded) > 32768 ||
      sourceIds.length > 50 ||
      new Set(sourceIds).size !== sourceIds.length ||
      sourceIds.some((id) => !/^[0-9a-f-]{36}$/.test(id))
    )
      throw new Error("invalid_checkpoint");
    const scope = await this.search.scope(groupId, actor);
    await this.store.transaction(async (c) => {
      const runtime = (await c.query("SELECT * FROM runtime_state FOR SHARE"))
        .rows[0];
      const group = (
        await c.query("SELECT * FROM groups WHERE id=$1 FOR SHARE", [groupId])
      ).rows[0];
      if (
        runtime.mode !== "open" ||
        runtime.generation !== scope.generation ||
        group.state !== "active" ||
        group.revision !== scope.revision
      )
        throw new Error("search_unavailable");
      const live = await c.query(
        "SELECT id FROM sources WHERE id=ANY($1::uuid[]) AND group_id=$2 AND state NOT IN ('revoked','expired','failed') AND expires_at>$3 ORDER BY id FOR SHARE",
        [sourceIds, groupId, this.store.now()],
      );
      if (live.rowCount !== sourceIds.length) throw new Error("search_gone");
      const session = (
        await c.query<Session>(
          "SELECT * FROM conversations WHERE group_id=$1 AND actor_id=$2 FOR UPDATE",
          [groupId, actor],
        )
      ).rows[0];
      if (
        !session ||
        session.generation !== generation ||
        session.runtime_generation !== runtime.generation ||
        session.last_interaction_at.getTime() + IDLE <=
          this.store.now().getTime()
      )
        throw new Error("search_gone");
      await c.query(
        "UPDATE conversations SET checkpoint_ciphertext=$2,checkpoint_sources=$3 WHERE id=$1",
        [
          session.id,
          this.store.cipher.sealPayload(
            encoded,
            `checkpoint:${session.id}:${generation}`,
          ),
          sourceIds,
        ],
      );
    });
  }
  async checkpoint(
    groupId: string,
    actor: string,
  ): Promise<{ generation: string; value: unknown } | undefined> {
    const scope = await this.search.scope(groupId, actor);
    return this.store.transaction(async (c) => {
      const group = (
        await c.query("SELECT * FROM groups WHERE id=$1 FOR SHARE", [groupId])
      ).rows[0];
      if (group.state !== "active" || group.revision !== scope.revision)
        throw new Error("search_unavailable");
      const session = (
        await c.query(
          "SELECT * FROM conversations WHERE group_id=$1 AND actor_id=$2",
          [groupId, actor],
        )
      ).rows[0];
      if (
        !session?.checkpoint_ciphertext ||
        session.runtime_generation !== scope.generation ||
        session.last_interaction_at.getTime() + IDLE <=
          this.store.now().getTime()
      )
        return;
      const live = await c.query(
        "SELECT id FROM sources WHERE id=ANY($1::uuid[]) AND group_id=$2 AND state NOT IN ('revoked','expired','failed') AND expires_at>$3 ORDER BY id FOR SHARE",
        [session.checkpoint_sources, groupId, this.store.now()],
      );
      const current = (
        await c.query("SELECT * FROM conversations WHERE id=$1 FOR SHARE", [
          session.id,
        ])
      ).rows[0];
      const runtime = (await c.query("SELECT * FROM runtime_state")).rows[0];
      if (
        runtime.mode !== "open" ||
        runtime.generation !== scope.generation ||
        live.rowCount !== session.checkpoint_sources.length ||
        current.generation !== session.generation ||
        current.checkpoint_ciphertext !== session.checkpoint_ciphertext
      )
        return;
      return {
        generation: session.generation,
        value: JSON.parse(
          this.store.cipher.openPayload(
            session.checkpoint_ciphertext,
            `checkpoint:${session.id}:${session.generation}`,
          ),
        ) as unknown,
      };
    });
  }
  async processOne(): Promise<boolean> {
    const job = await this.store.transaction(async (c) => {
      await c.query(
        `UPDATE search_jobs j SET state=CASE WHEN j.expires_at<=$2 THEN 'cancelled' ELSE 'failed' END,request_ciphertext=NULL,lease_until=NULL,fence=j.fence+1
        FROM conversations s,groups g,runtime_state r WHERE j.conversation_id=s.id AND s.group_id=g.id AND g.channel_id=$1 AND r.mode='open'
        AND j.state IN ('queued','running') AND (j.expires_at<=$2 OR j.attempts>=3 AND j.lease_until<=$2)`,
        [this.store.channelId, this.store.now()],
      );
      const row = (
        await c.query<QueryJob>(
          `SELECT j.* FROM search_jobs j JOIN conversations s ON s.id=j.conversation_id JOIN groups g ON g.id=s.group_id JOIN runtime_state r ON r.mode='open' AND r.generation=j.runtime_generation
    WHERE g.channel_id=$1 AND g.state='active' AND s.generation=j.conversation_generation AND s.last_interaction_at>$2 AND j.expires_at>$3 AND j.attempts<3 AND (j.state='queued' OR j.state='running' AND j.lease_until<=$3) AND NOT EXISTS(SELECT 1 FROM search_jobs older WHERE older.conversation_id=j.conversation_id AND older.state IN ('queued','running') AND older.sequence<j.sequence) ORDER BY j.sequence FOR UPDATE OF j SKIP LOCKED LIMIT 1`,
          [
            this.store.channelId,
            new Date(this.store.now().getTime() - IDLE),
            this.store.now(),
          ],
        )
      ).rows[0];
      if (!row) return;
      return (
        await c.query<QueryJob>(
          "UPDATE search_jobs SET state='running',fence=fence+1,attempts=attempts+1,lease_until=$2 WHERE id=$1 RETURNING *",
          [
            row.id,
            new Date(
              this.store.now().getTime() + (row.use_agent ? 60_000 : 30_000),
            ),
          ],
        )
      ).rows[0]!;
    });
    if (!job) return false;
    try {
      const session = await this.store.transaction((c) => this.valid(c, job));
      const input = JSON.parse(
        this.store.cipher.openPayload(
          job.request_ciphertext!,
          `search-request:${job.id}`,
        ),
      ) as SearchInput;
      const valid = async () =>
        this.store.transaction(async (c) => {
          const current = (
            await c.query<QueryJob>("SELECT * FROM search_jobs WHERE id=$1", [
              job.id,
            ])
          ).rows[0];
          if (
            !current ||
            current.fence !== job.fence ||
            current.state !== "running" ||
            !current.lease_until ||
            current.lease_until <= this.store.now()
          )
            throw new Error("search_gone");
          await this.valid(c, current);
        });
      let previous: SearchResult | undefined;
      if (job.use_agent && this.agent) {
        const checkpoint = await this.checkpoint(
          session.group_id,
          session.actor_id,
        );
        const context = resourceContext.safeParse(checkpoint?.value);
        if (context.success && context.data.sourceIds.length) {
          const candidates = await this.search.query(
            session.group_id,
            session.actor_id,
            { query: "資料" },
            undefined,
            context.data.sourceIds,
          );
          previous = {
            ...candidates,
            items: candidates.items.filter((i) =>
              context.data.sourceIds.includes(i.id),
            ),
          };
        }
      }
      const result =
        job.use_agent && this.agent
          ? await this.agent.query(
              job.id,
              session.group_id,
              session.actor_id,
              input,
              valid,
              job.excluded_source_id ?? undefined,
              previous,
            )
          : await this.search.query(
              session.group_id,
              session.actor_id,
              input,
              job.excluded_source_id ?? undefined,
            );
      await this.store.transaction(async (c) => {
        const group = (
          await c.query("SELECT state FROM groups WHERE id=$1 FOR SHARE", [
            session.group_id,
          ])
        ).rows[0];
        if (group.state !== "active") throw new Error("search_paused");
        const candidates = (
          await c.query(
            "SELECT id,revision,description_revision,state,expires_at FROM sources WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE",
            [result.items.map((i) => i.id)],
          )
        ).rows;
        if (
          candidates.length !== result.items.length ||
          candidates.some(
            (s) =>
              ["revoked", "expired", "failed"].includes(s.state) ||
              s.expires_at <= this.store.now() ||
              !result.items.some(
                (i) =>
                  i.id === s.id &&
                  i.revision === s.revision &&
                  i.descriptionRevision === s.description_revision,
              ),
          )
        )
          throw new Error("search_gone");
        await this.valid(c, job);
        const current = (
          await c.query<QueryJob>(
            "SELECT * FROM search_jobs WHERE id=$1 FOR UPDATE",
            [job.id],
          )
        ).rows[0]!;
        if (
          current.fence !== job.fence ||
          current.state !== "running" ||
          !current.lease_until ||
          current.lease_until <= this.store.now()
        )
          throw new Error("search_gone");
        await c.query(
          "UPDATE model_runs SET state='completed' WHERE id=$1 AND state='running'",
          [job.id],
        );
        const ids = [
          ...new Set([
            ...(job.excluded_source_id ? [job.excluded_source_id] : []),
            ...result.items.flatMap((i) => [
              i.id,
              ...i.versions.flatMap((v) => [v.id, v.evidenceSourceId]),
            ]),
          ]),
        ];
        await c.query(
          "UPDATE conversations SET checkpoint_ciphertext=$2,checkpoint_sources=$3 WHERE id=$1",
          [
            session.id,
            this.store.cipher.sealPayload(
              JSON.stringify({
                kind: "resource_context_v1",
                sourceIds: result.items.map((i) => i.id),
              }),
              `checkpoint:${session.id}:${session.generation}`,
            ),
            ids,
          ],
        );
        await c.query(
          "UPDATE search_jobs SET state='ready',request_ciphertext=NULL,result_ciphertext=$2,source_ids=$3,expires_at=$4,lease_until=NULL WHERE id=$1",
          [
            job.id,
            this.store.cipher.sealPayload(
              JSON.stringify(result),
              `search-result:${job.id}`,
            ),
            ids,
            new Date(this.store.now().getTime() + 86400000),
          ],
        );
      });
    } catch {
      await this.store.pool.query(
        "UPDATE search_jobs SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,request_ciphertext=CASE WHEN attempts>=3 THEN NULL ELSE request_ciphertext END,lease_until=NULL WHERE id=$1 AND fence=$2 AND state='running'",
        [job.id, job.fence],
      );
    }
    return true;
  }
}
