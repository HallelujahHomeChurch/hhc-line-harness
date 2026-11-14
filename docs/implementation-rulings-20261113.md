# Implementation rulings — 2026-11-13

Chronological execution decisions, preserved verbatim from the local ledger. Historical pending statements describe their original stage; final status is in [local acceptance](acceptance-local-20261113.md). Task 14 remains pending.

Ruling: Use a distinct hhc-line-harness Asset owner rather than legacy caller alias — keeps existing ownership checks effective and avoids exposing new data to the old caller — existing collection ownership must be explicitly handed off during authorized cutover, preserving IDs.

Ruling: New harness repository has no origin/main; isolate subsequent work from its verified local genesis 853b178 — preserve bootstrap and local-only authority — remote integration remains pending.

Ruling: Generate binding generations from a database sequence attached to the existing federated identity, rather than retain a separate table keyed by deleted LINE IDs — prevents generation reuse and avoids new raw-identity retention — restored sequence state still needs the global restore fencing acceptance in Task 11.

Task4 intake RED→GREEN on real task-owned PG: receipt/source/job/wake atomicity, five concurrent redeliveries, rollback/retry, inactive/old content suppression; 16 tests passed, no skips. Migration runner locks schema history and rejects checksum/history drift; default runtime closed. Ruling: accept ordinary source events at most 24 hours old and retain minimal receipts 7 days; runtime ingestion floor and active interval remain stricter. This bounds receipt cleanup without permitting old-message resurrection; lifecycle/tombstone/restore handling remains Task5/11, and these defaults require local load/retention evidence before real admission.

Ruling: one reader addition per announced setup — bounded exact subject/label/revision can be reviewed and audited using existing Account search + Asset ACL CAS — multiple additions require separate previews; do not batch silently.

Presenter tests: parser9 RED→GREEN, transport2 RED→GREEN (32 total), scoped/control3 RED→GREEN (35 total), sync68 pass, cached/native62 pass, playback60 pass, mainwiring145 pass; first full run367files had4643pass1skip3fail (poster mock missing readable helper; local-source snapshot changed only undefined field). Fixed mock and omitted source deadline from legacy projections; focused30pass. Full lint/typecheck green before latest native control/extra tests; desktop build ongoing /tmp/harness-presenter-build.log. No task7 commit yet. Must finish source reset/resume/valid offline tests, fresh full tests/builds/hosted smoke, docs; then task8. Ruling: download queue owns access-error cleanup after detaching failed jobs; do not await root cleanup inside provider download (self-wait deadlock). Browser bounded temporary blob is client playback only, not a second persisted server source. No real LINE/provider/hardware/cloud calls.

Task7 verification update: Asset full race1910pass7skip0fail, vet/build pass; committed701ba09. Gateway whole race onlyfailed newOpenAPI inventory; corrected inventory then docs/verifierrace pass, allotherpackagespass, vetpass; rebuilt image line-harness-gateway-local:task7 and isolated actualimage media smoke MEDIA_SYNC_ROUTING_OK; committed0959124. Presenter full367files4650pass1skip0fail. Desktop/web builds and bundle limits pass. Hosted-artifact Chromium synthetic PDF/PPTX offline/service-worker smoke1pass (DNS external resolution blocked, taskport18736, no userbrowserprofile). Later lint found wrapper render-time Date.now; replaced with existing-project useSyncExternalStore pattern; targeted46pass, lint0errors1unrelated FolderBrowserwarning. Final native export read path uses same deadline guard;7tests/nodeTypecheckpass. Final desktop rebuild running, then commitTask7. Ruling: repo-required Playwright CI smoke uses its existing isolated test runner; no personal browser/profile or real service credentials. No hardware/CI/release claim.

Task8 Ruling: advance this unreleased harness runtime from Node24 to published Node26.13.1 LTS (Lithium), verified process.release.lts and official nodejs/node v26.13.1 permissions docs. Node24 lacks network permission controls; Node26 restricted extraction child denies network, child processes, native addons, workers and writes by default. This is a guard for trusted parsers handling untrusted data, not a guarantee against hostile executable code (official docs explicitly exclude that). Local dlx downloaded official node binary, no repo workspace/security exceptions changed. Recheck all existing harness tests underNode26. Public dependency candidates from registry: pdfjs-dist6.5.438,fflate0.8.3,fast-xml-parser5.12.0. No dependencies installed yet; actual parser capability probe decides supported implementation. Original plan files unchanged.

Task8 Ruling: support XLSX cached values explicitly; legacy XLS remains searchable metadata/original with unsupported_spreadsheet, not fabricated contents. CPU wall8s/V8heap192MiB and input/output/decompression limits are bounded parser guards, not hostile-code sandbox. Container CPU/memory policy remains Task10. Short-term idle expiry preserves completed24h results; explicit reset cancels results and generation. This follows source spec6.3, not treating all TTLs as identical. Exact quoted relations are persisted; version proposals/Agents tools followTask9, no title/time-only inference. Source edit external Audit producer hookup followsTask10.

Task 9: Ruling: payload encryption inherited the 512-byte Reply token limit, incompatible with Task 8's 32 KiB checkpoint/long evidence contract — add separate 64 KiB payload entrypoints and migrate product-data callers, preserving Reply token bounds and AAD — oversized protected evidence otherwise fails rather than leaking or truncating. Regression RED→GREEN.

Task 9: Ruling: a process crash after claiming a model/tool step with no recorded completion stops that run as unknown; completed steps replay only with identical application-owned request and fresh authorization — no speculative replay or provider-state sharing — occasional interrupted work requires a new explicit query. Unknown costs retain their original-month reservation for reconciliation.

Task 9: Ruling: model-authored free text cannot substantiate successful mutations or source existence — final structured output selects only backend-owned evidence and recorded draft handles, rendered deterministically — less fluent prose, with truthful source/status/confirmation behavior. The model still interprets requests and selects bounded tools.

Task 9: Ruling: use a separate bounded embedding worker and exact group-filtered pgvector scan, not an ANN index or implicit provider substitution — fewer isolation/recall failure modes and no mixed model vectors — high-volume latency is a Task11 measurement and external acceptance gate. Each version must finish current backfill and record >=30-case >=90% top-5 evaluation before CAS activation; synthetic engine evidence is not real model quality.

Task 9: Ruling: keep only bounded source handles/metadata references for follow-ups and reload current data, rather than persisting provider conversations or summaries — fresh authority/revisions remain decisive and ordinary reads do not depend on Account — less conversational prose/history, with no additional summary bill.

Task 9: Ruling: model-derived version links persist only as attributed candidates backed by an exact live source quote, with uncalibrated confidence; they cannot mark confirmed or replace originals — meets derived-evidence provenance without granting document instructions mutation authority — candidate judgments can still be wrong and are visibly labeled.

Task 10: Ruling: existing operations route is Azure Monitor + existing service-health Action Group, not Operations API — reuse bounded console events/KQL; export is never delivery acknowledgement. Pending alert retries persist until operator verifies Monitor delivery. Cloud alert adoption/real delivery remains Task14, no fabricated HTTP notification endpoint.

Task11 Ruling: current external journal custody, coverage proof and all-writer shutdown are mandatory operator prerequisites, not inferred from a database backup or closed intake — fail closed if unavailable — disaster recovery remains unavailable until those external controls exist. API generation pin alone is not process draining. No production integration is claimed.

Task11 Ruling: published Node bookworm image failed strict Trivy (35 OS +6 bundled npm high/critical); replace runtime with supported official Distroless Node26 Debian13 nonroot at digest767ffb7e (Node26.13.1 verified), preserve gate, no upstream patches — runtime lacks shell/package managers and all operational commands must use compiled Node entrypoints. Rebuilt image e5e53099951a5a3fad88614ca3238caba265ed7f5aa312c2e1c144d405cff135 passes Linux nonroot/read-only startup, repeated migrations, network-isolated extraction and graceful shutdown; pinned Trivy0.74.0 exit0/high-critical0. Logs .artifacts/task11-image-smoke-distroless.log and task11-trivy-distroless.log. Application production dependency audit clean.

Task12 Ruling: legacy Graph/catalog/manual cleanup remains a durable owner handoff, not a fabricated new remote adapter or legacy Bot dependency — manifest requires a non-retiring owner and external acceptance evidence; missing/unknown owners or indefinite policy cannot import/retire — until actual owner read-denial/cleanup integration is accepted, real handoff remains blocked. Local evidence hashes are operator attestations, not proof of cloud fencing. No production source data collected or owner acceptance invented.

Task12 Ruling: preserve old feature/API code until observed consumers, main weekly-paper/profile responsibilities, source lifecycle owners and bounded rollback are accepted — removing them now would violate local-only preparation scope — task14 includes actual removal/revocation/archive and remains pending.

Final: Ruling: unbound LINE authors use existing anonymous/empty Audit actor with explicit line_author authority; verified Admin uses real Account UUID/website_admin — preserves privacy and no forced website membership — audit consumers must interpret anonymous as lacking Account identity, not absent LINE authorization. Receiver enforces the pairing; no raw LINE identity or content exported.

Final: Ruling: external Asset IDs remain bounded safe opaque strings and existing UUID fixtures remain exact text; never remove hyphens heuristically — owner identity must not be rewritten — any previously coerced real data needs explicit reconciliation before admission; this work had no real writes.

Final: Ruling: reviewer declined live LINE/Account/Asset/Audit behavior — retain Task14 acceptance; local contracts cannot prove deployed credentials/routes — incorrect environment setup can still block service.

Final: Ruling: reviewer declined actual cross-service disaster recovery — require external journal custody/freshness and stop every writer, fail closed without proof — no production RPO/RTO guarantee.

Final: Ruling: reviewer declined legacy retirement completion — owner evidence/actual single-writer fencing and bounded rollback remain mandatory — manifest alone cannot make legacy paths safe.

Final: Ruling: reviewer declined cloud queue/scaler/identity/CI/CD runtime — source changes and synthetic images remain local evidence — cold-start and actual routes remain unaccepted.

Final: Ruling: reviewer declined physical Presenter/exported-copy behavior — retain real-device acceptance; exported copies cannot be recalled — offline-copy limits remain user-visible.

Final: Ruling: reviewer declined real model quality/availability/billing — synthetic retrieval and reservation math do not prove actual quality/cost — paid representative acceptance remains pending.

Final: Ruling: reviewer declined final image afterTask12 — rebuilt actual fixed Harness/Audit source and reran Linux smoke; final security scan pending — do not use older Task11 image evidence as current.

Final evidence update: the final-image security gate mentioned in the last ruling subsequently passed for all four listed images. All five review findings were fixed; no Minor findings were deferred.
