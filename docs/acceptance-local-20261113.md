# Local implementation acceptance — 2026-11-13

Historical snapshot: this document records the local implementation before the PR/repeated-review phase. Current repository/PR and review status are in [README](../README.md) and [review rounds](review-rounds-20261113.md). Counts and no-PR statements below describe that earlier snapshot.

Status at capture: Tasks 1–13 implemented and verified locally, including the fresh independent review and all five findings fixed. **Not production accepted, not ready for webhook cutover.** Task 14 remains pending external authority and actual environment/owner decisions. No PR/push/merge/deployment, real LINE/provider/cloud trial, credential revocation or legacy archival occurred.

## Verification levels

Owning repository tests, real disposable PostgreSQL, synthetic HTTP/SDK clients, actual local Gateway image routing, offline Chromium and Linux container checks are distinct evidence. They do not prove a fully deployed multi-service system. All external LINE/model/queue/storage/provider traffic in the application tests uses local substitutes; public dependency/image downloads are installation only.

One fresh read-only whole-branch review covered all eight repositories and reported two Critical and three Important findings, with no Minor findings. All five were independently checked against owning code and repaired with observed failing-then-passing regressions:

1. Asset opaque IDs: preserve exact bounded path-safe strings in clients and PostgreSQL; never coerce owner IDs to UUIDs. Harness/Account UUIDs remain UUIDs.
2. Asset wire response: consume actual `sourcePolicy` and readiness fields; use a fixture generated from the owning Go serializers and copied byte-for-byte to the consumer tests.
3. Presenter expired-cache cleanup: expired or invalid deadlines still deny reading, while deletion removes browser/native blobs with correct reference counts.
4. Group deletion/re-registration: finalize deletion only after cleanup, then require fresh Admin/member checks and a new announcement; prior sources and intents remain denied.
5. Source mutation Audit: description/deletion changes and immutable audit facts commit atomically, with explicit author/Admin attribution, replay deduplication and recovery/dispatcher coverage.

No second independent review was run after fixes; regression tests and final owning checks provide the post-fix evidence. Architecture decisions and every recorded execution ruling are preserved in [implementation rulings](implementation-rulings-20261113.md).

## Repository evidence (final implementation revisions)

| Repository | Local head | Checks already performed | Limits |
| --- | --- | --- | --- |
| Harness | `1a9a631bb5f437683be9d4e281ae1caf72ab0d0d` | 173 tests, no skips; types/format/build/import boundaries; 4 compiled extraction + 3 offline browser; real schema dump/restore; Linux nonroot/read-only startup, migrations twice, extraction/shutdown; production dependency audit; strict runtime Trivy; full-history Gitleaks | No remote/main/release infrastructure yet |
| Asset | `6d9de1b762face8ff35d0014346187ea471ee096` | Full Go race 1910 pass / 7 dependency skips; vet/build; PostgreSQL source/ACL/concurrency/read-path tests; OpenAPI; Audit fixture; Bicep compile; Linux API image build; post-review HTTP race and producer serializer golden fixture | Scan/media/cloud dependencies and real Dapr not accepted |
| Account API | `b6a743ab89bb5998b0e9213a9c77b9d562f930fd` | Full Go race 2541 pass / 12 dependency skips, subsequent Unicode/authority regression suite; vet/build/governance/release policy; disposable PG+Redis; Linux image build | Real identity binding/Entra/LINE not accepted |
| Gateway | `6d2f7dc8b6fa68ce31750923a90118497ce41744` | Go race 305 pass / 2 skips; vet; 15 route generation checks; generated policy/OpenAPI; actual image synthetic enabled/default-disabled/member/media routes; Bicep compile | No production host/workload credentials used |
| Account FE | `c2ec3cea07513f318fd2eda420e8d574dfb0e095` | 617 tests; lint/build/policies; Bicep compile | No real account/LINE browser acceptance |
| Admin FE | `c8122bb54d0b57ef6e71c902de202a2a51c67ba9` | 141 files / 1483 tests with two workers; lint/build/policies; Bicep compile | Unlimited-worker run had host-load timeouts in existing campaign tests; bounded rerun passed without relaxing timeouts |
| Presenter | `81c22c0dc6ef201f246ee55a2825a67826fa2096` | 367 files / 4652 pass / 1 skip; targeted native/deadline/control; lint (one pre-existing warning), typecheck, desktop/web builds and bundle checks; isolated hosted-artifact browser smoke | No real device/packaged release; Ray controls releases |
| Audit | `7762256b70722d2bff552f1fa5f6e25028139643` | Full Go race 645 pass / 16 dependency skips; vet; disposable PostgreSQL append-only/duplicate/lock/pool tests; bootstrap/release/runtime/OIDC policy; actual Linux nonroot health/ready/shutdown; Trivy high/critical 0; 55-commit Gitleaks 0 | Monitor recipient/delivery and deployed producer admission pending |

Task 13 additionally compiled six owning Bicep templates with a fresh empty Azure configuration directory (compile only), matched 31 producer actions across two fixtures exactly to Audit's catalog, and scanned all eight tracked source snapshots for dependency vulnerabilities at existing repo CI policy (`HIGH,CRITICAL`, fixed vulnerabilities) with exit 0. Final Harness and Audit runtime scans separately use the stricter no-ignore gate, including secrets. Asset and Account runtime scans preserve their existing fixed-vulnerability HIGH/CRITICAL gates. All exited 0. No security gate was disabled. Building/scanning an image is not deployment or live acceptance.

## Final local gates and reproduction

Planning governance was read at immutable revision `73ee1af2a1ff828d72421a73626f45ff4ce04a6f`. The five original plan documents passed their provenance hashes unchanged. Final code revision above excludes this report-only commit.

- Harness: `.artifacts/verify-task13.py` ran the complete 173-test suite with required real disposable PostgreSQL, explicit Node 26, typecheck/format/build, four compiled extraction tests, three offline Chromium tests, CI classification, import boundaries, production dependency audit, cross-service fixtures and plan hashes. Final task ledger: `.superpowers/sdd/implementation-20261112/task-13-tests.log`.
- Go owning checks use `go test -race -json ./... -count=1 -p=1` and `go vet ./...`; counts in the table distinguish conditional skips. Post-review Asset serializer/HTTP checks and Audit full race/vet were rerun. Audit `bash scripts/test-postgres-integration.sh` exited 0; its intentional rejected down-migration logs an inner exit 1 while verifying audit records remain intact.
- Presenter post-review full tests, lint, typechecks and desktop/web builds passed. The hosted-artifact offline browser smoke passed earlier in Task 7; it was not rerun after the cleanup-only repair, which has browser/native reference-count regression coverage.
- `.artifacts/check-cross-contracts.py`: 31 actions in two producer fixtures exactly match the receiver catalog; Asset serializer golden bytes exactly match Harness fixture bytes.
- `.artifacts/scan-repositories.py`: final tracked sources for all eight repositories and the four actual images below passed pinned Trivy checks. `.artifacts/task13-final-scans.log` records exit 0; detailed reports are in `.artifacts/task13-trivy.log`. Fixed-vulnerability source/Asset/Account policy and strict Harness/Audit image policy remain distinct.
- Final Harness and Audit histories passed pinned Gitleaks with redacted output and zero leaks. Owning logs: `.artifacts/task13-gitleaks.log`. No credentials were printed or persisted for the authorized dependency installation.
- Fresh final Harness/Audit Linux images passed nonroot startup/readiness/shutdown smoke; Harness additionally passed read-only startup, repeated migrations and network-isolated extraction. Asset/Account images were built and scanned; no full Linux HTTP startup or external scan/media/provider acceptance is claimed for them. Gateway's actual-image synthetic routing smoke is separate evidence.
- Six Bicep templates compiled using an empty task-local Azure configuration directory; no cloud configuration was applied. Remote GitHub CI and releases were not run.

| Local image tag | Verified image identity |
| --- | --- |
| `line-harness-local:final-20261113` | `sha256:7e301e93e0407bc8000f0736ba4cea9791f5d81e12b660fa428376b012c7e4f6` |
| `line-harness-audit-local:final-20261113` | `sha256:918ecdf8b122c2e747c35e4d1d82e6597e2f43cb63aab49745da00092ba6e0dc` |
| `line-harness-asset-local:20261113` | `sha256:f3e366807ce53109d82885cd5c7373c4511a75632da9abcc500104367a1519f9` |
| `line-harness-account-local:20261113` | `sha256:40a9a334c80cc2497cf43e2998bb339d2dd1d5f8e41748ea4afa606e593cb135` |

The execution ledger retains actual commands, failed fixture attempts, corrections and completion evidence. Fixture metadata now describes stopped resources; recreate disposable resources before reproducing database checks. This report does not equate build/security success with deployment acceptance.

## T01–T45 evidence and outstanding acceptance

Each row maps local evidence to the original spec. “External” is outstanding, not a local pass for the entire criterion.

| ID | Local evidence | External / remaining acceptance |
| --- | --- | --- |
| T01 | events/server/intake: signed raw batches, malformed/mixed inputs, receipts/replay | Actual LINE retries and ingress |
| T02 | registration/interactions + Account authority lifecycle | Real binding, role changes, announcement receipt |
| T03 | protected-content/search/agent-tools/admin-queries: group and direct-chat separation | Live membership/device routes |
| T04 | membership and current authority failure/expiry tests | LINE membership freshness/limits |
| T05 | durable intake/original-worker/vertical: save and restart | Actual supported attachment types and storage |
| T06 | media-provider/original-worker: limits, disappearance, unknown readiness | LINE download failure behavior |
| T07 | search + embedding synthetic 30-case engine evaluation ≥90% top-5 | De-identified real corpus/model quality and measured cost |
| T08 | exact quoted source relations and model-derived candidate provenance | Human relevance/version judgment |
| T09 | lifecycle/source-policy/retention: deadline, unsend, pause, revision denial | End-to-end deployed callback propagation |
| T10 | delivery/conversations/interactions: 30-minute/reset/unknown Reply | Real 5-second experience and Reply API semantics |
| T11 | bounded PDF/XLSX extraction, malicious XML/zip limits, Node permissions | Production container limits and representative real files |
| T12 | official SDK with intercepted transport, strict tools, durable unknown/completed steps | Actual provider refusal/outage/usage behavior |
| T13 | actual disposable schema dump/restore, current journal, late original/embedding results, orphan cleanup | External journal custody, disaster RPO/RTO, remote late effects |
| T14 | vertical synthetic save/restart/find/deny plus independent registration tests | Full real Admin→group→attachment→Presenter/device sequence |
| T15 | concurrent PG $500 cap, Azure threshold durable alerts, unknown reservations | Provider billing reconciliation and Monitor delivery receipt |
| T16 | source-edits/management previews, actor/revision/expiry confirmation | Real user confirmation flow |
| T17 | Taipei month boundaries, sticky fallback, versioned indexing and alert deduplication | Actual cross-month provider usage/outage |
| T18 | same-message original/staged publication identity and unknown recovery | Shared real Asset bytes + Presenter consumption |
| T19 | Asset read-path tests, current Account subject, forwarded/manager ticket denial | Deployed workload/user/member credentials |
| T20 | lifecycle and Presenter policy/deadline/control fixtures | Real offline copies, reconnect, cleanup on hardware |
| T21 | exact workload/profile preflight and producer no-scan policy tests | Deployed dedicated caller and actual upload response acceptance |
| T22 | immutable source deadline SQL/worker/restore and Asset GET/HEAD/Range checks | Live delayed upload/retention/purge interaction |
| T23 | Asset callback/ACL/current-role/GET/HEAD/Range/conditional read tests | Full production route and ticket matrix |
| T24 | registration revision/CAS/concurrent/unknown-announcement tests | Real Account + group announcement race |
| T25 | PG crash/replay/unknown completion and local 500-event load | Zero-replica Queue/scaler cold start and first-burst timings |
| T26 | legacy mutation denial and Presenter cache/native/lease tests | Actual current/older clients and hardware |
| T27 | typed scope errors, expired A with valid B, transient dependency behavior | Device reconnection/ACL changes |
| T28 | multi-page reset/control revision and pause/resume fixtures | Offline policy changes over real sync |
| T29 | deadline through cache/native lease; existing OneDrive/local tests | Actual always-offline device playback and expiry deletion |
| T30 | immutable legacy manifest identities; no import-created binary/root/publication | Existing collection ownership transfer, cursors/bytes/reference verification |
| T31 | local ingest latency recorded; Presenter polling preserved | Stage-by-stage cold media latency and Operations fallback |
| T32 | exact capability gate + closed defaults + compatible rollback contract | Consumer-first release and real older-client inventory |
| T33 | Account generation/admin revision remove/re-add/rebind + stale intent tests | Real account switch and disaster recovery across services |
| T34 | Asset staged/ACL/binding CAS + Harness operation/announcement fencing | Deployed cross-system lost-response/race rehearsal |
| T35 | held jobs resume only for valid admitted sources; unknown publication reconciliation | Runtime scaling/restart with paused group |
| T36 | source identity/deadline keyed per LINE message; no cross-message byte dedupe | Same actual attachment reposted at different times |
| T37 | staged/activate lost-result reconciliation and cursor exclusion tests | Real Asset metadata recovery under timeout |
| T38 | separate minimal control route and transient/scoped errors | Deployed Account/Bot outage and device behavior |
| T39 | Account/Asset/Gateway workload scope and spoofed-header synthetic tests | Real issuer/audience/rotation and current Presenter identity |
| T40 | Complete source-level helper/main responsibility inventory prepared | Named owner decisions and stop/replacement acceptance; not done |
| T41 | Legacy method/path/consumer inventory and new-source bypass denial | Actual consumer inventory and authorized old-route/code removal; not done |
| T42 | immutable handoff state/generation, unknown effects block admission | Stop/fence real writers, cancel old intents, actual single webhook switch |
| T43 | legacy unsend-before/after-import, original expiry, current journal restore; owner gate | Retained owner must enforce all real legacy read/cleanup paths |
| T44 | immutable Audit facts/payload, lease/retry/dead-letter/restore + exact catalog fixtures | Deployed Audit admission/outage/retry receipt |
| T45 | retirement validator rejects missing evidence/unknown cleanup/open rollback window | Verify revoked access is denied; disable CI/scaler/jobs and archive after rollback; not done |

## Retained resources and boundaries

All feature branches/worktrees remain unmerged for review. No existing user/permanent/Codex worktree or unrelated Docker resource is removed. Task-owned native PostgreSQL is stopped; the exact Harness PostgreSQL and Account Redis containers are stopped and removed (Redis auto-removed). Their absence was verified. Test evidence and local images are retained. The original five plan files remain byte-identical; additional rulings/evidence are separate documents.
