# Sequential implementation — 2026-11-12

Specification: `plans/2026-11-09-line-agent-harness-plan-v2.md`, especially §13.3–13.4. Preserve all five original plan documents byte-for-byte. Local implementation/synthetic verification only. Asset base fd1e808 + bootstrap 0f87767; harness genesis 853b178. Planning governance revision 73ee1af2a1ff828d72421a73626f45ff4ce04a6f.

Use isolated task worktrees; read owning instructions before edits. TDD critical boundaries. Commit each cohesive verified unit locally. Run targeted tests while implementing and required full checks before delivery. Retain unfinished worktrees. No push, merge, deployment, intake, paid calls or retirement.

### Task 1: Asset fixed unscanned contract

Fixed verified-principal pair; immutable source identity and 90-day deadline; byte validation, truthful readiness, no scan queue; legacy profiles unchanged.

Verification: Asset policy/service/HTTP/PostgreSQL tests, migrations, race suite and vet.
Expected: all named checks pass, invalid/unknown states fail closed, existing consumers remain compatible. Record actual commands and evidence in the execution ledger.

### Task 2: Asset source enforcement and publication

Current-source gate on all content paths; current Account subject; typed failures; owner metadata reconciliation; staged/activate, ACL CAS and control sync; independent expiry cleanup.

Verification: Revocation, pause, callback failures, replay/activation concurrency, tickets and GET/HEAD/Range integration tests.
Expected: all named checks pass, invalid/unknown states fail closed, existing consumers remain compatible. Record actual commands and evidence in the execution ledger.

### Task 3: Account identity contract

Dedicated new caller endpoint scopes, existing binding lifecycle, trusted admin actor with binding generation and transactional admin authorization revision; narrow current-user subject.

Verification: Role remove/re-add, switch/unbind/rebind, caller and audience contract tests.
Expected: all named checks pass, invalid/unknown states fail closed, existing consumers remain compatible. Record actual commands and evidence in the execution ledger.

### Task 4: Harness durable entry and group registration

PG migrations, bounded raw signed batches, durable receipt/job transaction, group-first intents, website admin continuation, original group confirmation and announcement; encrypted reply reservation and unknown recovery.

Verification: Synthetic webhook and real local PG concurrency/crash/replay tests; no Push.
Expected: all named checks pass, invalid/unknown states fail closed, existing consumers remain compatible. Record actual commands and evidence in the execution ledger.

### Task 5: Original media worker and lifecycle

PG leases/fencing and opaque-ID outbox wake; download to Asset with idempotent completion; source authorization, unsend-first and 90-day expiry, pause/held work; protected group download and publication reconciliation.

Verification: Local fault-injected vertical save/restart/find/revoke flow and dependency-failure tests.
Expected: all named checks pass, invalid/unknown states fail closed, existing consumers remain compatible. Record actual commands and evidence in the execution ledger.

### Task 6: Account and admin websites; Gateway

Binding continuation invalidation, metadata-only admin context, previewed/versioned ACL and group controls; owning Gateway manifests and exact scopes; legacy new-source bypass denied.

Verification: Frontend tests/typecheck/build and Gateway generation/route tests.
Expected: all named checks pass, invalid/unknown states fail closed, existing consumers remain compatible. Record actual commands and evidence in the execution ledger.

### Task 7: Presenter source policy compatibility

Shared parser, typed scope errors, control sync, hard deadline in caches/native lease; preserve IDs, valid always-offline data and existing 2/15/60-second polling.

Verification: Pause/resume/reset, A expired with valid B, revoked ACL and offline deadline tests; build.
Expected: all named checks pass, invalid/unknown states fail closed, existing consumers remain compatible. Record actual commands and evidence in the execution ledger.

### Task 8: Search, safe extraction and conversation

Bounded embedded PDF text/Excel values, metadata/text search and version-aware results; protected checkpoints/reset, author/admin confirmation and long-task status.

Verification: Malicious document and scope tests; synthetic 30-case retrieval evaluation with >=90% top-5.
Expected: all named checks pass, invalid/unknown states fail closed, existing consumers remain compatible. Record actual commands and evidence in the execution ledger.

### Task 9: Agent and provider budgets

Official Agents SDK/Responses and Azure adapter; typed tools, no content tracing, tool ledger; shared run budget, Taipei month reservations, OpenAI $500 cap, Azure $100 alert and recovery.

Verification: Stubbed model and concurrent PG budget/fallback/cross-month tests; no paid calls.
Expected: all named checks pass, invalid/unknown states fail closed, existing consumers remain compatible. Record actual commands and evidence in the execution ledger.

### Task 10: Audit and operational delivery

Dedicated Audit producer/catalog and transactional harness audit outbox; retry/dead-letter recovery; health/metrics/alerts, no LINE notifications.

Verification: Business/audit atomicity, dependency outage and producer scope tests.
Expected: all named checks pass, invalid/unknown states fail closed, existing consumers remain compatible. Record actual commands and evidence in the execution ledger.

### Task 11: Resilience and recovery

Monotonic tombstones, backup restore fencing, late-worker results, cleanup and load measurements; migration/deployment compatibility contracts.

Verification: Disposable local backup/restore and fault/load tests; no cloud changes.
Expected: all named checks pass, invalid/unknown states fail closed, existing consumers remain compatible. Record actual commands and evidence in the execution ledger.

### Task 12: Cutover and retirement preparation

Endpoint/consumer/owner inventory, immutable legacy lifecycle manifest importer, single-writer handoff state, unknown publication reconciliation, rollback and retirement gates.

Verification: Synthetic handoff/unsend/restore and failed-gate tests. No cutover, credential revocation, deletion or archival.
Expected: all named checks pass, invalid/unknown states fail closed, existing consumers remain compatible. Record actual commands and evidence in the execution ledger.

### Task 13: Whole-branch verification and review

Run owning-repository required checks, cross-service local synthetic acceptance, fresh whole-branch review and fix critical/important findings.

Verification: Report exact commits, checks and T01–T45 evidence; distinguish local/CI/device/production.
Expected: all named checks pass, invalid/unknown states fail closed, existing consumers remain compatible. Record actual commands and evidence in the execution ledger.

### Task 14: External acceptance and retirement gates

Real LINE/device/provider/cloud acceptance, consumer-first deployment, controlled groups, cutover and bounded rollback, retirement after ownership decisions.

Verification: Requires additional explicit authority; leave pending, never mark locally complete.
Expected: all named checks pass, invalid/unknown states fail closed, existing consumers remain compatible. Record actual commands and evidence in the execution ledger.

## Review Focus

Cross-service authorization races; persisted revision fencing; publication unknown outcomes; immutable source deadlines independent of collection retention; every byte access path; backup resurrection; truthfulness of local versus external evidence.
