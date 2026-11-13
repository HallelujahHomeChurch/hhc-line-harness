import type { Store } from "../persistence/store.ts";
import { normalize, terms } from "./terms.ts";
export interface SearchInput {
  query: string;
  authorId?: string;
  kind?: string;
  publishedFrom?: string;
  publishedBefore?: string;
}
export interface SearchItem {
  id: string;
  revision: string;
  descriptionRevision: string;
  name: string;
  authorId: string | null;
  publishedAt: string;
  expiresAt: string;
  kind: string;
  description: string | null;
  snippet: string;
  indexState: string;
  gaps: string[];
  contentPath: string | null;
  versions: {
    id: string;
    name: string;
    evidenceSourceId: string;
    evidence: string;
    confidence: number;
    producer?: "explicit" | "model";
    status: "candidate" | "confirmed";
  }[];
}
export type SourceProposal =
  | { sourceId: string; kind: "delete" }
  | { sourceId: string; kind: "description"; text: string };
export interface SearchResult {
  proposal?: SourceProposal;
  status:
    | "success"
    | "not_found"
    | "ambiguous"
    | "pending_index"
    | "incomplete"
    | "unavailable";
  items: SearchItem[];
  gaps: string[];
}
export class Search {
  readonly store: Store;
  readonly member: (group: string, actor: string) => Promise<boolean>;
  constructor(
    store: Store,
    member: (group: string, actor: string) => Promise<boolean>,
  ) {
    this.store = store;
    this.member = member;
  }
  async scope(groupId: string, actor: string) {
    if (!/^[0-9a-f-]{36}$/.test(groupId) || !/^U[0-9a-f]{32}$/.test(actor))
      throw new Error("search_forbidden");
    const row = (
      await this.store.pool.query(
        `SELECT g.*,r.generation,r.mode FROM groups g CROSS JOIN runtime_state r WHERE g.id=$1 AND g.channel_id=$2`,
        [groupId, this.store.channelId],
      )
    ).rows[0];
    if (!row || row.mode !== "open") throw new Error("search_unavailable");
    if (row.state !== "active") throw new Error("search_paused");
    if (!(await this.member(row.line_group_id, actor)))
      throw new Error("search_forbidden");
    return row;
  }
  validate(input: SearchInput) {
    return Search.validateInput(input);
  }
  static validateInput(input: SearchInput) {
    if (
      typeof input.query !== "string" ||
      !input.query.trim() ||
      [...input.query].length > 200 ||
      Object.keys(input).some(
        (k) =>
          ![
            "query",
            "authorId",
            "kind",
            "publishedFrom",
            "publishedBefore",
          ].includes(k),
      )
    )
      throw new Error("invalid_search");
    if (
      input.authorId !== undefined &&
      (typeof input.authorId !== "string" ||
        !/^U[0-9a-f]{32}$/.test(input.authorId))
    )
      throw new Error("invalid_search");
    if (
      input.kind !== undefined &&
      !["text", "file", "image", "audio", "video"].includes(input.kind)
    )
      throw new Error("invalid_search");
    for (const date of [input.publishedFrom, input.publishedBefore])
      if (
        date !== undefined &&
        (typeof date !== "string" ||
          !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(date) ||
          !Number.isFinite(Date.parse(date)) ||
          new Date(date).toISOString() !== date)
      )
        throw new Error("invalid_search");
    if (
      input.publishedFrom &&
      input.publishedBefore &&
      input.publishedFrom >= input.publishedBefore
    )
      throw new Error("invalid_search");
    const tokens = terms(input.query);
    if (!tokens.length || tokens.length > 200)
      throw new Error("invalid_search");
    return tokens;
  }
  async query(
    groupId: string,
    actor: string,
    input: SearchInput,
    excludedSourceId?: string,
    candidateIds: string[] = [],
  ): Promise<SearchResult> {
    if (
      candidateIds.length > 20 ||
      new Set(candidateIds).size !== candidateIds.length ||
      candidateIds.some((id) => !/^[0-9a-f-]{36}$/.test(id))
    )
      throw new Error("invalid_search");
    const tokens = this.validate(input),
      first = await this.scope(groupId, actor);
    const result = await this.store.transaction(async (c) => {
      await c.query("SET LOCAL statement_timeout='2000ms'");
      const rows = (
        await c.query(
          `SELECT s.*,coalesce(i.state,CASE WHEN j.state='failed' THEN 'failed' END) AS index_state,coalesce(i.code,CASE WHEN j.state='failed' THEN 'index_failed' END) AS code,i.extracted_text,
    (SELECT count(*) FROM unnest(i.terms) term WHERE term=ANY($4::text[])) AS score
    FROM sources s LEFT JOIN source_indexes i ON i.source_id=s.id AND i.source_revision=s.revision AND i.runtime_generation=$3 LEFT JOIN jobs j ON j.source_id=s.id AND j.kind='index'
    WHERE s.group_id=$1 AND s.id IS DISTINCT FROM $9::uuid AND s.state NOT IN ('revoked','expired','failed') AND s.expires_at>$2
    AND ($5::text IS NULL OR s.author_id=$5) AND ($6::text IS NULL OR s.kind=$6)
    AND ($7::timestamptz IS NULL OR s.published_at>=$7) AND ($8::timestamptz IS NULL OR s.published_at<$8)
    AND (s.id=ANY($10::uuid[]) OR i.terms && $4::text[] OR EXISTS(SELECT 1 FROM unnest($4::text[]) t WHERE position(t in lower(coalesce(s.file_name,'')||' '||coalesce(s.description,'')||' '||coalesce(s.body,'')))>0))
    ORDER BY array_position($10::uuid[],s.id) ASC NULLS LAST,score DESC,s.id LIMIT 501`,
          [
            groupId,
            this.store.now(),
            first.generation,
            tokens,
            input.authorId ?? null,
            input.kind ?? null,
            input.publishedFrom ?? null,
            input.publishedBefore ?? null,
            excludedSourceId ?? null,
            candidateIds,
          ],
        )
      ).rows;
      const coverage = (
        await c.query(
          `SELECT count(*) AS pending,count(*) FILTER(WHERE i.state='failed' OR j.state='failed') AS failed FROM sources s
        LEFT JOIN source_indexes i ON i.source_id=s.id AND i.source_revision=s.revision AND i.runtime_generation=$3
        LEFT JOIN jobs j ON j.source_id=s.id AND j.kind='index'
        WHERE s.group_id=$1 AND s.expires_at>$2 AND s.state NOT IN ('revoked','expired','failed') AND (i.source_id IS NULL OR i.state IN ('failed','incomplete'))`,
          [groupId, this.store.now(), first.generation],
        )
      ).rows[0];
      const pending = Number(coverage.pending),
        failed = Number(coverage.failed);
      const phrase = normalize(input.query);
      const score = (s: (typeof rows)[number]) =>
        (candidateIds.includes(s.id)
          ? 1000000 - candidateIds.indexOf(s.id) * 1000
          : 0) +
        Number(s.score) +
        (normalize(s.file_name ?? "").includes(phrase)
          ? tokens.length * 4
          : 0) +
        (normalize(s.extracted_text ?? s.body ?? "").includes(phrase)
          ? tokens.length * 2
          : 0);
      rows.sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));
      const items: SearchItem[] = [];
      for (const s of rows.slice(0, 5)) {
        const relations = (
          await c.query(
            `SELECT rel.related_source_id AS id,rel.evidence_source_id,rel.confidence,rel.status,rel.producer,target.file_name,coalesce(rel.evidence_quote,evidence.body) AS body FROM source_relations rel JOIN sources target ON target.id=rel.related_source_id JOIN sources evidence ON evidence.id=rel.evidence_source_id
     WHERE rel.source_id=$1 AND rel.kind='version' AND target.group_id=$2 AND evidence.group_id=$2 AND target.state='ready' AND evidence.state='ready' AND target.expires_at>$3 AND evidence.expires_at>$3 ORDER BY rel.related_source_id,rel.evidence_source_id LIMIT 10`,
            [s.id, groupId, this.store.now()],
          )
        ).rows;
        const indexState = s.index_state ?? "pending";
        items.push({
          id: s.id,
          revision: s.revision,
          descriptionRevision: s.description_revision,
          name: s.file_name ?? (s.kind === "text" ? "文字訊息" : "未命名附件"),
          authorId: s.author_id,
          publishedAt: s.published_at.toISOString(),
          expiresAt: s.expires_at.toISOString(),
          kind: s.kind,
          description: s.description,
          snippet: (s.extracted_text ?? s.body ?? "").slice(0, 400),
          indexState,
          gaps: [
            ...(indexState === "ready" ? [] : [s.code ?? "pending_index"]),
            "applicable_period_not_confirmed",
            ...(relations.some((r) => r.status === "confirmed")
              ? []
              : ["version_not_confirmed"]),
          ],
          contentPath:
            s.asset_id && s.state === "ready"
              ? `/api/line/sources/${s.id}/content`
              : null,
          versions: relations.map((r) => ({
            id: r.id,
            evidenceSourceId: r.evidence_source_id,
            name: r.file_name ?? "文字訊息",
            evidence: (r.body ?? "").slice(0, 200),
            confidence: r.confidence,
            producer: r.producer,
            status: r.status,
          })),
        });
      }
      return {
        items,
        more: rows.length > 500,
        pending,
        failed,
        tied: rows.length > 1 && score(rows[0]) === score(rows[1]),
      };
    });
    const last = await this.scope(groupId, actor);
    if (
      first.revision !== last.revision ||
      first.generation !== last.generation
    )
      throw new Error("search_unavailable");
    if (result.items.length) {
      const ids = result.items.map((i) => i.id);
      const current = (
        await this.store.pool.query(
          "SELECT id,revision,description_revision,state,expires_at FROM sources WHERE id=ANY($1::uuid[])",
          [ids],
        )
      ).rows;
      if (
        current.length !== ids.length ||
        current.some(
          (s) =>
            s.expires_at <= this.store.now() ||
            ["revoked", "expired", "failed"].includes(s.state) ||
            !result.items.some(
              (i) =>
                i.id === s.id &&
                i.revision === s.revision &&
                i.descriptionRevision === s.description_revision,
            ),
        )
      )
        throw new Error("search_unavailable");
    }
    return {
      status: result.more
        ? "incomplete"
        : result.items.length
          ? result.tied
            ? "ambiguous"
            : "success"
          : result.failed
            ? "unavailable"
            : result.pending
              ? "pending_index"
              : "not_found",
      items: result.items,
      gaps: [
        ...(result.pending ? ["index_coverage_incomplete"] : []),
        ...(result.more ? ["candidate_limit"] : []),
      ],
    };
  }
}
