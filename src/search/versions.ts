import type { Search, SearchItem } from "./search.ts";
export async function proposeVersion(
  search: Search,
  groupId: string,
  actor: string,
  runId: string,
  input: {
    sourceId: string;
    relatedId: string;
    evidenceId: string;
    quote: string;
    confidence: number;
  },
): Promise<SearchItem["versions"][number]> {
  if (
    input.sourceId === input.relatedId ||
    [...input.quote].length < 4 ||
    [...input.quote].length > 200 ||
    !Number.isFinite(input.confidence) ||
    input.confidence < 0 ||
    input.confidence > 1
  )
    throw new Error("invalid_version_candidate");
  const scope = await search.scope(groupId, actor),
    store = search.store;
  return store.transaction(async (c) => {
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
      throw new Error("version_scope_changed");
    const ids = [
      ...new Set([input.sourceId, input.relatedId, input.evidenceId]),
    ];
    const rows = (
      await c.query(
        "SELECT * FROM sources WHERE id=ANY($1::uuid[]) AND group_id=$2 AND state='ready' AND expires_at>$3 ORDER BY id FOR SHARE",
        [ids, groupId, store.now()],
      )
    ).rows;
    if (rows.length !== ids.length) throw new Error("version_source_changed");
    const evidence = (
      await c.query(
        "SELECT coalesce(i.extracted_text,s.body,'') AS text FROM sources s LEFT JOIN source_indexes i ON i.source_id=s.id AND i.source_revision=s.revision AND i.runtime_generation=$2 WHERE s.id=$1",
        [input.evidenceId, scope.generation],
      )
    ).rows[0];
    if (!evidence?.text.includes(input.quote))
      throw new Error("version_evidence_missing");
    await c.query(
      "INSERT INTO source_relations(source_id,related_source_id,kind,confidence,status,evidence_source_id,evidence_quote,producer,model_run_id) VALUES($1,$2,'version',$3,'candidate',$4,$5,'model',$6) ON CONFLICT(source_id,related_source_id,kind) DO UPDATE SET confidence=EXCLUDED.confidence,evidence_source_id=EXCLUDED.evidence_source_id,evidence_quote=EXCLUDED.evidence_quote,model_run_id=EXCLUDED.model_run_id WHERE source_relations.producer='model' AND source_relations.status='candidate'",
      [
        input.sourceId,
        input.relatedId,
        input.confidence,
        input.evidenceId,
        input.quote,
        runId,
      ],
    );
    const actual = (
      await c.query(
        "SELECT rel.*,target.file_name,coalesce(rel.evidence_quote,evidence.body,'') AS quote FROM source_relations rel JOIN sources target ON target.id=rel.related_source_id JOIN sources evidence ON evidence.id=rel.evidence_source_id WHERE rel.source_id=$1 AND rel.related_source_id=$2 AND rel.kind='version' AND target.group_id=$3 AND evidence.group_id=$3 AND target.state='ready' AND evidence.state='ready' AND target.expires_at>$4 AND evidence.expires_at>$4",
        [input.sourceId, input.relatedId, groupId, store.now()],
      )
    ).rows[0];
    if (!actual) throw new Error("version_source_changed");
    return {
      id: actual.related_source_id,
      name: actual.file_name ?? "文字訊息",
      evidenceSourceId: actual.evidence_source_id,
      evidence: actual.quote.slice(0, 200),
      confidence: actual.confidence,
      status: actual.status,
      producer: actual.producer,
    };
  });
}
