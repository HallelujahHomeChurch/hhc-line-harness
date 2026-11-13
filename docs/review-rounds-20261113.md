# Three-consultant review and release handoff

The user requested three independent consultants, fixes for confirmed findings, and another fresh three-consultant round after fixes. A separate user-visible session may begin sequential merge/release only after no actionable findings remain. The new Bot has its own private repository, `HallelujahHomeChurch/hhc-line-harness`; the legacy repository is archived only after accepted replacement, ownership handoff and the bounded rollback period. No automatic Presenter tag/release is authorized.

## Round 1

Three actual Codex consultants independently reviewed source/diff in five-minute read-only seats: UI/UX and consumer experience; product workflow and lifecycle; cross-service contracts and release dependencies. They did not run tests, mutate repositories or call real providers. Existing local test receipts were not independent review evidence. At dispatch there were no PRs for these branches; Draft PRs follow the fixes.

| Finding | Resolution | Regression evidence |
| --- | --- | --- |
| P2 Admin invalid collection name permanently locks retry | Match the server's UTF-8 bound before requesting; definite 400 releases the pending operation, unknown outcomes preserve the same operation and immutable name | Overlong Chinese name, definite rejection/correction and ambiguous-result same-operation retry |
| P2 LIFF reset response races a subsequent search | Serialize reset with search/result controls and fence search/reset callbacks by UI generation | Delayed old search completion during reset cannot unlock search; search after reset can retrieve results |
| P1 source invalidation/leave cancels or holds unpublish jobs | Keep cleanup/unpublish eligible; sweep requeues interrupted/terminal unpublish jobs when revoked publications remain, retaining exact identities and waking the same job | queued/leased/retry_wait/held/cancelled/completed × unsend/leave/expiry; actual PostgreSQL and fake remote deletion receipts; deletion reaches terminal state |
| P1 closed admission discards denial events | Persist authenticated group unsend/leave/memberLeft while ordinary admission stays closed; restoring still rejects writes and requires independent lifecycle custody | Signed HTTP webhook through Store, current source denial, legacy denial in closed handoff, ordinary/restoring writes rejected |
| P2 abandoned drafts permanently reserve collections | Serialize collection reservation reclamation with configuration/announcement; retain current bindings, valid intents, pending originals/publications and unknown/announcing/active effects | Changed/expired draft reuse succeeds; unknown effect remains exclusive |

The cross-service seat found no confirmed contract defect in its inspected paths. Its incomplete coverage and unmeasured risks remain explicit: per-item source callback latency for full collection pages, and the new current-Account dependency for legacy collection listing when the resolver is enabled. These are runtime rollout checks, not claimed passing performance/availability acceptance.

A fresh full run also exposed a date-sensitive test fixture: Audit used a fixed application clock but the database's real default retry time. The fixture now sets its initial retry time from the same test clock. This changes no runtime logic. The stopped failing run is retained as evidence; it was not counted as passing.

Post-fix local verification: Harness 179 tests / zero skips, four compiled extraction tests, four offline Chromium tests, types/format/build/boundaries/provenance and production dependency audit pass. Admin Console 141 files / 1484 tests, lint and build pass; one existing vite.config triple-slash warning remains. Owning unchanged checks are recorded in the earlier local acceptance report. Current remote CI, independent round 2 and runtime acceptance are separate gates.

## Restore and retirement boundary

Closed admission is not an all-writer stop. Before restoring, an independently durable lifecycle owner must receive denials while the database and serving writers are stopped, and reconcile current denials into the external signed policy journal. Never switch the webhook to an isolated restoring database or assume LINE redelivery is durable custody. Missing custody keeps admission closed. Do not archive the legacy owner while it is still needed for retained sources, old routes or rollback.
