import type { PoolClient } from "pg";
import type { SearchResult } from "../search/search.ts";
export const MAX_PUBLIC_DEPENDENCIES = 256;
export type TurnDependency = NonNullable<SearchResult["dependencies"]>[number];
export interface PublicTurnDraft {
  messageId: string;
  publishedAt: string;
  question: string;
  kind: "answer" | "clarification";
  followUp: "continue" | "awaiting" | "closed";
  dependencies: TurnDependency[];
  parent?: { id: string; version: string };
}
interface DependencyRow {
  id: string;
  revision: string;
  description_revision: string;
  expires_at: Date;
  state: string;
}
function matchesDependencies(
  dependencies: TurnDependency[],
  rows: Map<string, DependencyRow>,
  now: Date,
) {
  return (
    dependencies.length <= MAX_PUBLIC_DEPENDENCIES &&
    new Set(dependencies.map((d) => d.id)).size === dependencies.length &&
    dependencies.every((d) => {
      const r = rows.get(d.id);
      return (
        r &&
        r.revision === d.revision &&
        r.description_revision === d.descriptionRevision &&
        r.expires_at > now &&
        r.expires_at.toISOString() === d.expiresAt &&
        !["revoked", "expired", "failed"].includes(r.state)
      );
    })
  );
}
async function dependencyRows(c: PoolClient, ids: string[], groupId: string) {
  const result = await c.query<DependencyRow>(
    "SELECT id,revision,description_revision,expires_at,state FROM sources WHERE id=ANY($1::uuid[]) AND group_id=$2 ORDER BY id FOR SHARE",
    [ids, groupId],
  );
  return new Map(result.rows.map((r) => [r.id, r]));
}
export async function liveTurnDependencies(
  c: PoolClient,
  dependencies: TurnDependency[],
  groupId: string,
  now: Date,
) {
  return matchesDependencies(
    dependencies,
    await dependencyRows(
      c,
      dependencies.map((d) => d.id),
      groupId,
    ),
    now,
  );
}
interface StoredTurn {
  id: string;
  actor_id: string;
  event_at: Date;
  event_id: string;
  delivered_at: Date;
  line_message_ids: string[];
  question_ciphertext: string;
  answer_ciphertext: string;
  kind: "answer" | "clarification";
  follow_up: "continue" | "awaiting" | "closed";
  dependencies: TurnDependency[];
  version: string;
  consumed_by: string | null;
  expires_at: Date;
}
const ownedPending = (row: StoredTurn, actor: string) =>
  row.actor_id === actor && row.follow_up === "awaiting" && !row.consumed_by;
async function validTurns(
  c: PoolClient,
  turns: StoredTurn[],
  groupId: string,
  now: Date,
) {
  const rows = await dependencyRows(
    c,
    [...new Set(turns.flatMap((t) => t.dependencies.map((d) => d.id)))],
    groupId,
  );
  return turns.filter((t) => matchesDependencies(t.dependencies, rows, now));
}
// Approximate token budget: non-ASCII codepoints cost one, ASCII four per token.
function clip(text: string, tokens: number) {
  let used = 0,
    result = "";
  for (const char of text) {
    const cost = char.codePointAt(0)! > 127 ? 1 : 0.25;
    if (used + cost > tokens) break;
    used += cost;
    result += char;
  }
  return { text: result, used };
}
function clipAnswer(text: string, tokens: number, preserveQuestion: boolean) {
  const part = clip(text, tokens);
  if (!preserveQuestion || part.text === text) return part;
  const head = clip(text, tokens / 3),
    tail = clip([...text].reverse().join(""), tokens - head.used - 1);
  return {
    text: head.text + "…" + [...tail.text].reverse().join(""),
    used: head.used + tail.used + 1,
  };
}
import { createHash } from "node:crypto";
import type { Store, IntakeGroup } from "../persistence/store.ts";
import type { LineEvent } from "./events.ts";
import type { Search, ConversationTurn } from "../search/search.ts";
export interface TurnRequest {
  eventId?: string;
  messageId: string;
  publishedAt: string;
  quotedMessageId?: string;
  mode: "explicit" | "implicit" | "candidate";
  parentId?: string;
  parentVersion?: string;
  canAnswerPending?: boolean;
}
export interface GroupContext {
  pendingTurns?: { id: string; version: string }[];
  needsFreshContext?: boolean;
  actor: string;
  askedAt?: string;
  mode: TurnRequest["mode"];
  quoteMissing: boolean;
  parentId?: string;
  parentVersion?: string;
  canAnswerPending?: boolean;
  history: ConversationTurn[];
  messages: {
    speaker: string;
    at: string;
    text: string;
    quotedMessageId?: string;
  }[];
  dependencies: TurnDependency[];
}
const alias = (id: string) =>
  "member_" + createHash("sha256").update(id).digest("hex").slice(0, 10);
const directCall = (text: string) =>
  /^小哈(?:[，,:：！!？?\s]|$)/u.test(text.trim());
const endTurn = (text: string) =>
  /^(?:謝謝(?:你)?|感謝|不用了|先這樣|結束|thanks?|thank you)[。！!\s]*$/iu.test(
    text.trim(),
  );
export async function closeGroupTurns(
  c: PoolClient,
  groupId: string,
  actor: string,
  at: Date,
  eventId = "",
) {
  await c.query(
    "INSERT INTO group_turn_resets(group_id,actor_id,closed_at,closed_event_id) VALUES($1,$2,$3,$4) ON CONFLICT(group_id,actor_id) DO UPDATE SET closed_at=EXCLUDED.closed_at,closed_event_id=EXCLUDED.closed_event_id WHERE group_turn_resets.closed_at<EXCLUDED.closed_at OR (group_turn_resets.closed_at=EXCLUDED.closed_at AND group_turn_resets.closed_event_id<>'' AND (EXCLUDED.closed_event_id='' OR group_turn_resets.closed_event_id<EXCLUDED.closed_event_id))",
    [groupId, actor, at, eventId],
  );
}
export class GroupTurns {
  readonly store: Store;
  readonly search: Search;
  readonly groups: readonly string[];
  constructor(store: Store, search: Search, groups: readonly string[] = []) {
    this.store = store;
    this.search = search;
    this.groups = groups;
  }
  enabled(groupId: string) {
    return this.groups.includes(groupId);
  }
  async close(
    c: PoolClient,
    groupId: string,
    actor: string,
    at: Date,
    eventId = "",
  ) {
    await closeGroupTurns(c, groupId, actor, at, eventId);
  }

  async candidate(
    c: PoolClient,
    event: LineEvent,
    group: IntakeGroup,
  ): Promise<TurnRequest | undefined> {
    if (
      !this.enabled(group.id) ||
      group.state !== "active" ||
      !group.active_from ||
      event.publishedAt < group.active_from ||
      event.message?.type !== "text" ||
      !event.actorId
    )
      return;
    const m = event.message,
      text = m.text ?? "",
      explicit = m.mentionsBot || directCall(text);
    if (
      !explicit &&
      ((m.mentionsOthers && !/(?:給|替|幫|for)\s*@/iu.test(text)) ||
        /^(?:大家|各位|阿[\p{L}]{1,4}|小(?!哈)[\p{L}]{1,4})[，,:：\s]/u.test(
          text,
        ) ||
        endTurn(text))
    ) {
      await this.close(c, group.id, event.actorId, event.publishedAt, event.id);
      return;
    }
    const base = {
      eventId: event.id,
      messageId: m.id,
      publishedAt: event.publishedAt.toISOString(),
      ...(m.quotedMessageId ? { quotedMessageId: m.quotedMessageId } : {}),
    };

    const rows = (
      await c.query<StoredTurn>(
        `SELECT t.* FROM group_turns t JOIN runtime_state r ON t.runtime_generation=r.generation
    WHERE group_id=$1 AND group_revision=$2 AND answer_ciphertext IS NOT NULL AND expires_at>$3 AND delivered_at<=$4
    AND (NOT EXISTS(SELECT 1 FROM group_turn_resets x WHERE x.group_id=t.group_id AND x.actor_id=$5 AND t.actor_id=$5 AND (x.closed_at>t.event_at OR x.closed_at=t.event_at AND (x.closed_event_id='' OR x.closed_event_id>=t.event_id))) OR $6=ANY(t.line_message_ids))
    ORDER BY ($6=ANY(line_message_ids)) DESC NULLS LAST,(actor_id=$5 AND follow_up='awaiting' AND consumed_by IS NULL) DESC,event_at DESC,delivered_at DESC,id DESC LIMIT 20`,
        [
          group.id,
          group.revision,
          this.store.now(),
          event.publishedAt,
          event.actorId,
          m.quotedMessageId ?? null,
        ],
      )
    ).rows;
    const live = await validTurns(c, rows, group.id, this.store.now());
    const quoted = m.quotedMessageId
      ? live.find((r) => r.line_message_ids.includes(m.quotedMessageId ?? ""))
      : undefined;
    const pending = live.find((r) => ownedPending(r, event.actorId!));
    if (explicit) {
      const parent = quoted ?? pending;
      return {
        ...base,
        mode: "explicit",
        ...(parent
          ? {
              parentId: parent.id,
              parentVersion: parent.version,
              canAnswerPending: ownedPending(parent, event.actorId),
            }
          : {}),
      };
    }
    if (m.quotedMessageId)
      return quoted
        ? {
            ...base,
            mode: "implicit",
            parentId: quoted.id,
            parentVersion: quoted.version,
            canAnswerPending: ownedPending(quoted, event.actorId),
          }
        : undefined;
    if (pending)
      return {
        ...base,
        mode: "candidate",
        parentId: pending.id,
        parentVersion: pending.version,
        canAnswerPending: true,
      };
    const last = live[0];
    if (!last) return;
    const reference =
      /(?:第[一二三四五六七八九十0-9]+|那[份個項]|這[份個項]|剛才|上面|改短|改長|草稿|方案|選項|繼續)/u.test(
        text,
      );
    const question =
      /(?:你(?:能|可以|會|覺得|知道|有)|請|幫我|怎麼|如何|為什麼|能否|可否|[?？])/u.test(
        text,
      );
    const intervening = (
      await c.query(
        "SELECT 1 FROM sources WHERE group_id=$1 AND kind='text' AND message_id<>$2 AND published_at>$3 AND published_at<$4 LIMIT 1",
        [group.id, m.id, last.delivered_at, event.publishedAt],
      )
    ).rowCount;
    // Uninterrupted same-speaker continuity establishes a candidate regardless
    // of sentence form; the existing tool-free Agent still decides whether to reply.
    if (
      last.actor_id === event.actorId &&
      last.follow_up === "continue" &&
      !intervening
    )
      return {
        ...base,
        mode: "implicit",
        parentId: last.id,
        parentVersion: last.version,
      };
    if (reference || (last.actor_id === event.actorId && question))
      return { ...base, mode: "candidate" };
    await this.close(c, group.id, event.actorId, event.publishedAt, event.id);
  }
  async context(
    groupId: string,
    actor: string,
    request: TurnRequest,
  ): Promise<GroupContext> {
    const scope = await this.search.scope(groupId, actor);
    return this.store.transaction(async (c) => {
      const group = (
        await c.query("SELECT * FROM groups WHERE id=$1 FOR SHARE", [groupId])
      ).rows[0];
      if (group.state !== "active" || group.revision !== scope.revision)
        throw Error("search_gone");
      const pendingTurns: NonNullable<GroupContext["pendingTurns"]> = [];
      const history: ConversationTurn[] = [],
        messages: GroupContext["messages"] = [],
        dependencies = new Map<string, TurnDependency>();
      let needsFreshContext = false;
      let budget = 2000,
        quoteMissing = Boolean(request.quotedMessageId);
      const turns = (
        await c.query<StoredTurn>(
          `SELECT * FROM group_turns t WHERE group_id=$1 AND group_revision=$2 AND runtime_generation=$3 AND answer_ciphertext IS NOT NULL AND expires_at>$4 AND delivered_at<=$5
    AND (NOT EXISTS(SELECT 1 FROM group_turn_resets x WHERE x.group_id=t.group_id AND x.actor_id=$8 AND t.actor_id=$8 AND (x.closed_at>t.event_at OR x.closed_at=t.event_at AND (x.closed_event_id='' OR x.closed_event_id>=t.event_id))) OR $6=ANY(t.line_message_ids))
    ORDER BY ($6=ANY(line_message_ids)) DESC NULLS LAST,(actor_id=$8 AND follow_up='awaiting' AND consumed_by IS NULL) DESC,(id=$7) DESC NULLS LAST,event_at DESC,delivered_at DESC,id DESC LIMIT 20`,
          [
            groupId,
            scope.revision,
            scope.generation,
            this.store.now(),
            request.publishedAt,
            request.quotedMessageId ?? null,
            request.parentId ?? null,
            actor,
          ],
        )
      ).rows;
      const live = await validTurns(c, turns, groupId, this.store.now());
      if (request.parentId && !live.some((t) => t.id === request.parentId))
        throw Error("turn_gone");
      const reset = (
        await c.query(
          "SELECT closed_at,closed_event_id FROM group_turn_resets WHERE group_id=$1 AND actor_id=$2",
          [groupId, actor],
        )
      ).rows[0];
      const sources = (
        await c.query(
          `SELECT * FROM sources WHERE group_id=$1 AND kind='text' AND state='ready' AND expires_at>$2 AND (published_at<$3 OR published_at=$3 AND ($6::text IS NULL OR event_id<=$6)) AND message_id<>$4 AND body IS NOT NULL ORDER BY (message_id=$5) DESC,published_at DESC,event_id DESC LIMIT 20`,
          [
            groupId,
            this.store.now(),
            request.publishedAt,
            request.messageId,
            request.quotedMessageId ?? null,
            request.eventId ?? null,
          ],
        )
      ).rows;
      const addSource = (row: (typeof sources)[number]) => {
        const part = clip(
          row.body,
          Math.min(
            row.message_id === request.quotedMessageId ? 700 : 200,
            budget,
          ),
        );
        budget -= part.used;
        messages.push({
          speaker: alias(row.author_id ?? "unknown"),
          at: row.published_at.toISOString(),
          text: part.text,
          ...(row.quoted_message_id
            ? { quotedMessageId: row.quoted_message_id }
            : {}),
        });
        dependencies.set(row.id, {
          id: row.id,
          revision: row.revision,
          descriptionRevision: row.description_revision,
          expiresAt: row.expires_at.toISOString(),
        });
      };
      const quote = sources.find(
        (r) => r.message_id === request.quotedMessageId,
      );
      if (quote) {
        addSource(quote);
        quoteMissing = false;
      }
      const isQuoted = (row: StoredTurn) =>
        row.line_message_ids.includes(request.quotedMessageId ?? "");
      const visible = live.filter(
        (row) =>
          !reset ||
          row.actor_id !== actor ||
          isQuoted(row) ||
          row.event_at > reset.closed_at ||
          (+row.event_at === +reset.closed_at &&
            reset.closed_event_id &&
            row.event_id > reset.closed_event_id),
      );
      const essential = (row: StoredTurn) =>
        isQuoted(row) ||
        ownedPending(row, actor) ||
        (row.id === request.parentId &&
          !row.consumed_by &&
          row.follow_up !== "closed");
      let requiredRemaining = visible.filter(essential).length;
      if (requiredRemaining > Math.floor((20 - messages.length) / 2))
        needsFreshContext = true;
      for (const row of visible) {
        const quoted = isQuoted(row);
        const required = essential(row);
        if (
          new Set([
            ...dependencies.keys(),
            ...row.dependencies.map((d) => d.id),
          ]).size >
          MAX_PUBLIC_DEPENDENCIES - 1
        ) {
          if (required) needsFreshContext = true;
          else continue;
        }
        if (quoted) quoteMissing = false;
        const answer = this.store.cipher.openPayload(
            row.answer_ciphertext,
            `turn-answer:${row.id}`,
          ),
          question = this.store.cipher.openPayload(
            row.question_ciphertext,
            `turn-question:${row.id}`,
          );
        if (budget < 100 || messages.length + history.length * 2 >= 20) break;
        const allowance = required
          ? Math.floor(budget / Math.max(1, requiredRemaining--))
          : budget;
        const q = clip(question, Math.min(250, allowance / 3)),
          a = clipAnswer(
            answer,
            Math.min(600, allowance - q.used),
            row.follow_up === "awaiting" && !row.consumed_by,
          );
        const item = {
          user: q.text,
          assistant: a.text,
          speaker: alias(row.actor_id),
          at: row.event_at.toISOString(),
          eventId: row.event_id,
          kind: row.kind,
          followUp: row.consumed_by ? "closed" : row.follow_up,
          turnId: row.id,
        };
        budget -= q.used + a.used;
        history.push(item);
        if (ownedPending(row, actor))
          pendingTurns.push({ id: row.id, version: row.version });
        for (const d of row.dependencies as TurnDependency[])
          dependencies.set(d.id, d);
      }
      for (const row of sources) {
        if (row === quote) continue;
        if (
          budget < 50 ||
          dependencies.size >= MAX_PUBLIC_DEPENDENCIES - 1 ||
          messages.length + history.length * 2 >= 20
        )
          break;
        addSource(row);
      }
      const availablePending =
        request.quotedMessageId && request.canAnswerPending
          ? pendingTurns.filter((t) => t.id === request.parentId)
          : pendingTurns;
      const currentParent =
        !request.quotedMessageId && availablePending.length === 1
          ? availablePending[0]
          : undefined;
      return {
        needsFreshContext,
        pendingTurns: availablePending,
        actor: alias(actor),
        askedAt: request.publishedAt,
        mode: request.mode,
        quoteMissing,
        parentId: currentParent?.id ?? request.parentId,
        parentVersion: currentParent?.version ?? request.parentVersion,
        canAnswerPending: currentParent ? true : request.canAnswerPending,
        history: history.sort(
          (a, b) =>
            a.at!.localeCompare(b.at!) ||
            (a.eventId ?? "").localeCompare(b.eventId ?? "") ||
            a.turnId!.localeCompare(b.turnId!),
        ),
        messages: messages.reverse(),
        dependencies: [...dependencies.values()],
      };
    });
  }
}
