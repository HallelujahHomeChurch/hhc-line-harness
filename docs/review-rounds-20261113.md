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

## Round 2

Three fresh Codex consultants reviewed the eight actual Draft PRs and their exact local heads, independently and read-only, across UI/UX, workflow and service contracts. They reported five actionable findings:

| Finding | Resolution | Regression evidence |
| --- | --- | --- |
| P2 transient result pickup discards the retry handle | Keep the same job and refresh action after network/503 failure; deny/expired responses still clear the result | Offline browser retries one job without another search/model request |
| P2 unknown source-edit confirmation cannot recover its outcome | Retain the same preview/token in the UI; the server returns a completed receipt under the same actor, membership, authority and generation fences without repeating effects | Browser same-request retry; PostgreSQL author/Admin receipts, audit uniqueness, authority/reset rejection |
| P3 selecting a new collection displays the previous audience | Hide the old audience and show a pending-save explanation until that destination is authoritative | Admin Console new-collection audience test |
| P2 closed admission stalls expiry and remote deletion | Continue expiry, cleanup and unpublish in closed mode; restoring still freezes maintenance and ordinary processing remains stopped | PostgreSQL closed expiry and worker cleanup; restoring no-effect check |
| P2 accepted Unicode filenames violate Asset item display-name bounds | Normalize only the publication display name to the owner's 255-byte UTF-8 limit, removing forbidden separators/control characters; retain original metadata | Five byte-identical producer/owner fixtures checked by the actual Go validator |

PR wording now accurately states that Account provides instructions to return to LINE setup rather than claiming an automatic redirect. Remote CI additionally exposed two integration omissions: Asset's reviewed additive CHECK-domain expansion needed the existing immutable-migration policy entry, and Gateway content downloads needed the stream capacity class. The exact migration hash and mutation-rejection checks retain the destructive-DDL guard; the generated Gateway route now uses its existing stream budget. No gate is bypassed.

The initial local rerun retained failures: the new checkout's external dependency symlink was incompatible with the extraction child's filesystem boundary, and an unrelated Admin campaign test timed out under concurrent load. Dependencies were copied into this checkout without widening extraction permissions; subsequent validation is recorded below. Neither initial failure is counted as passing. Harness rerun: 182 tests / zero skips, four compiled extraction tests, six offline Chromium tests, types/format/build/boundaries and dependency audit pass; immutable plan verification and cross-service fixtures pass. Admin full-suite and hosted checks remain separately tracked.

## Round 3

Three fresh read-only consultants reviewed the eight Draft PRs at the round-3 manifest heads. UI found an old download failure fencing a newer search/reset; workflow found ACL shrink permanently failing pending publication; the service seat found the current Presenter browser CI failure. No other confirmed cross-service wire mismatch was reported within its bounded coverage.

- Download callbacks now retain their initiating UI generation and cannot clear newer work. Both delayed-download/new-search and delayed-download/new-reset regressions failed before the fix.
- ACL shrink fences and holds queued/leased publication work before closing sharing. Publish claiming and wake dispatch respect that pause. Successful exact ACL reconciliation requeues eligible held work under the updated policy and preserves publication/item identity. PostgreSQL tests cover queued work and an old remote stage response arriving after the new ACL is accepted; both failed before the fix.
- Presenter browser Web Locks testing now loads the renderer's existing TypeScript path aliases, matching the production build and the existing speech test. Its focused actual-browser case and type checks pass; hosted full CI must pass separately.
- Coordinator follow-through found the closed-mode queue wake gate still prevented the lifecycle workers from starting. Closed mode now dispatches only cleanup/unpublish wakes; restoring dispatches none. The PostgreSQL regression failed before the fix and passes after it.

Admin's complete 141-file / 1485-test suite passed with two workers, and lint/build plus the six focused Console tests pass. The initial high-concurrency timeout receipts are retained; no assertions or timeouts were relaxed. Round-2 Harness hosted CI (including image smoke and security scan) passed. Round-3 local verification passes 185 tests / zero skips, four compiled extraction tests, eight Chromium cases, formatting/types/build/boundaries and dependency audit; current-head hosted CI remains a separate gate.

## Round 4

Three fresh read-only consultants reviewed all eight PR heads listed in the round-4 manifest. The service-contract seat reported no new confirmed mismatch; the UI/workflow seats identified four actionable defects:

- Active-group setup could update an ACL while an older publication lease retained the previous snapshot. Setup now fences publication jobs before the announcement/effect boundary; announcing or unknown approvals at the current group revision prevent fresh publish claims. A successfully accepted snapshot requeues the same publication identity. The delayed-stage/reader-expansion PostgreSQL regression failed before the fix.
- Expired or revoked LINE media could stop an unrelated current Bible/Timer projection. Presenter now checks the current projection owner and displayed item before stopping; old resources can still be released. Six expiry/removal cases cover media, Bible and Timer ownership.
- Asset collections failures or expired setup links prevented independent group pause/delete controls from loading. Admin Console loads groups independently and scopes non-authority setup/collection failures to their panels; authority loss still clears management controls. Tests cover 503, expired setup and a still-pending collection request.
- A submitted ACL confirmation could not recover after preview expiry or refresh. Admin distinguishes unused approval from an already-submitted operation, retains its same-actor/flow receipt across status/browser refresh, and explicitly retries that operation under current server authority. Unused approvals are not persisted; account/flow changes and navigation discard the local receipt. Success or definitive authority/policy rejection clears it.

The eight round-4 published heads all passed their applicable hosted checks before these newly identified fixes. This is historical evidence, not validation of the subsequent heads. Harness post-fix local validation passes 186 PostgreSQL/domain tests, four compiled extraction tests, eight browser cases, types/format/build/boundaries and dependency audit. Fresh three-consultant review and hosted checks remain required for the updated heads.

## Round 5

Three fresh read-only consultants reviewed the round-5 heads. The cross-service seat found no new confirmed mismatch. UI identified two remaining receipt-loss paths; workflow identified starvation in bounded unpublish scheduling.

- A submitted, unresolved confirmation now remains account-scoped across navigation and browser refresh. Cancel/new preview controls cannot discard or overwrite it; recovery still sends only the same operation/token under fresh server authorization. Unsubmitted approvals remain transient. This supersedes round 4's navigation-discard behavior.
- Collection creation persists its account-scoped operation ID and immutable name before requesting Asset. Unknown outcomes restore a “check creation result” action after navigation/refresh. Completion or definite validation rejection clears that receipt; it never silently creates a new operation on retry.
- Unpublish scheduling excludes already-revoked publications whose source has a live current-generation cleanup job. New obsolete publications and interrupted/terminal or obsolete-generation work remain repairable. The 51-source regression proves the first 50 unresolved remote outcomes cannot starve the next source, and terminal work is still requeued.

All three regressions failed before their fixes. Harness post-fix full local verification passes 187 tests / zero skips, four compiled extraction tests, eight Chromium cases, types/format/build/boundaries and dependency audit. Admin's focused recovery/management suite passes 13 cases; full-suite/current-head hosted receipts remain tracked separately. Fresh independent review is still required after these fixes.

## Restore and retirement boundary

Closed admission is not an all-writer stop. Before restoring, an independently durable lifecycle owner must receive denials while the database and serving writers are stopped, and reconcile current denials into the external signed policy journal. Never switch the webhook to an isolated restoring database or assume LINE redelivery is durable custody. Missing custody keeps admission closed. Do not archive the legacy owner while it is still needed for retained sources, old routes or rollback.

## Round 6

Three fresh read-only consultants identified four confirmed findings across UI/UX, recovery workflow and service contracts. Each was reproduced before its fix.

- LIFF result pickup now serializes reads, so an older pending/error response cannot overwrite a newer completed result from repeated refresh clicks.
- A submitted source confirmation has independent state and a separate recovery panel. Unknown results retain the exact operation/token; refresh, new search and reset cannot discard it. Successful or definitive denied/gone results release the controls. The browser regression covers the interrupted confirmation and same-operation retry.
- Recovery refuses to mark reconciliation complete when the current signed journal contains source/publication identities absent from the restored backup. It remains `restoring`, blocks admission and retains the signed-journal handoff requirement. Two PostgreSQL cases cover missing source and publication identities; there is no override that silently drops external cleanup obligations.
- Asset collection list/read audits now permit precisely the Harness service actor, with matching owning Audit catalog, helper validation and generated producer fixture. No human actor is fabricated and unrelated service principals remain denied. An HTTP test with real workload authentication, Audit validation, migrated PostgreSQL and durable outbox reproduces the former 503 and verifies both reads and provenance after the fix.

Harness full local verification passes 190 tests / zero skips, four compiled extraction tests and ten Chromium cases, plus types/format/build/boundaries/dependency audit. Audit source/vet, disposable PostgreSQL permissions/recovery and bootstrap checks pass. Asset HTTP/Audit/outbox race tests pass; full-suite and current-head hosted receipts are recorded separately. A fresh three-person round is required for these changed heads.

## Round 7

Three fresh read-only consultants reviewed the round-7 heads. The service and workflow seats found no new confirmed defects. UI identified two remaining recovery-entry gaps; both were reproduced and fixed.

- LIFF now stores a submitted confirmation receipt before the request, scoped by a hash of LIFF application, actor and group. It stores neither the raw ID token nor source contents. Reload restores an explicit same-operation retry without automatically sending a mutation; another account/group cannot see that entry. Every request still sends the raw ID token for independent server authentication. If session storage is unavailable, the initial mutation is not sent. The offline browser case covers actual reload, account/group isolation and successful receipt removal.
- Admin collection-creation recovery is an independent panel, so a missing/expired setup link, active setup or disabled sharing no longer hides the existing operation. It retains the original ID/name and reports success; it does not start another collection operation.

Harness full local verification passes 190 tests / zero skips, four compiled extraction tests, eleven Chromium cases and all source/build/boundary/dependency checks. Admin's fifteen focused cases and lint/build pass; isolated full-suite and current-head CI receipts remain separate. Decoded LIFF identity is used only for local storage scoping, consistent with the [official LIFF API contract](https://developers.line.biz/en/reference/liff/#get-decoded-id-token); it is never submitted as authority to the server. Another fresh three-person review is required for the updated heads.

## Round 8

Three fresh read-only consultants reviewed the round-8 heads. The service seat found no new confirmed defect. Workflow identified stale README delivery status; UI identified a storage-failure branch that could still send Admin mutations without a durable receipt.

- Both Admin collection creation and confirmation now synchronously save the receipt before sending the request. Storage refusal reports that no change was sent, leaves the unsubmitted action available, and sends zero mutations. Confirmation no longer relies on a later React effect to persist its operation. Two exception-injection regressions fail before the fix and pass afterward, including successful retry once storage is available.
- README now links the independent private repository PR and repeated-review record while distinguishing merge/release/runtime acceptance. The original local acceptance report is explicitly marked as a historical pre-PR snapshot; the five retained original plan files remain unchanged.

Admin's seventeen focused cases and lint/build pass. The preceding full revision passes all 141 files / 1494 tests when run alone with one worker; the prior concurrent contention failure remains retained. Final current-revision full-suite/hosted checks and a fresh three-consultant review are still required.

## Round 9

Three fresh read-only consultants reviewed the round-9 heads. Workflow found no new confirmed issue. UI identified unrelated-error receipt loss; services identified an ACL history/response-size mismatch.

- Unrelated Admin 401/403/409 failures preserve an already-submitted receipt. Only the same confirmation's definitive rejection or success clears it. Regressions inject reader 403/409, reload, and recover the same operation/token.
- The dedicated Harness collection picker omits ACL history at the owning Asset query. Detail selects current ACLs only with a 129-row sentinel and rejects more than 128 active readers; it never silently truncates an approval snapshot. Other callers retain full-history behavior. Harness budgets these two JSON responses at 128 KiB and counts only current readers. Owner PostgreSQL coverage creates 25 collections with 201 ACL rows each; consumer coverage uses the actual Go serializer fixture with 128 current readers, revoked history and bounded overflow.

The regressions failed before the fixes. Harness full local verification passes 191 tests / zero skips, four compiled extraction cases and eleven Chromium cases with source/build/boundary/dependency checks. Asset PostgreSQL, HTTP and Audit client race suites pass, as does vet. Admin's nineteen focused cases and lint/build pass; current full-suite/hosted receipts and fresh review remain required.
