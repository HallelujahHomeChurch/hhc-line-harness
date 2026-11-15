# Retained source authority implementation plan

> Execute inline with `superpowers:executing-plans`; use three fresh independent
> reviewers for the complete change, as required by this repository.

**Goal:** Provide the lifecycle authority needed by exact Asset adoption without
opening new intake or changing legacy deadlines.

**Architecture:** Harness owns denial state and a monotonic channel handoff
revision. Asset remains responsible for original bytes, scan/ACL enforcement,
independent adoption scope and physical cleanup. A dedicated retained check
shares the existing authenticated Asset callback boundary, not the new-source
90-day policy parser.

**Tech stack:** existing TypeScript, PostgreSQL, Fastify, Zod and Node tests.

**Spec:** `retained-source-handoff-20261115.md`; owning issue #8 and Asset #286.

## Constraints and review focus

- Preserve all five plans and every existing source deadline/provenance.
- No production import/adoption, webhook change or archival in this source PR.
- Closed intake can answer retained lifecycle checks; restoring/prepared or a
  mismatched generation cannot authorize reads.
- Repeated leave events while already blocked must invalidate an in-flight
  revalidation. Never infer a global revision from the maximum row revision.
- Unknown/mismatched mappings must fail closed without returning manifests.
- Asset-only restore scope fencing, cleanup and Presenter cache transition are
  separate owning implementations; this callback does not claim those gates.

## Task 1: Monotonic retained lifecycle decisions

**Files:** add `migrations/030_retained_authority.sql`,
`src/domain/retained-access.ts`, `tests/retained-access.test.ts`; modify
`src/domain/legacy.ts`, `src/bootstrap/runtime.ts`, `src/bootstrap/server.ts`,
`tests/server.test.ts`.

**Interface:** `RetainedAccess(store).checkBatch(input: unknown)` accepts a strict
version-1 object with `manifestDigest` (64 lowercase hex), `generation` (positive
decimal string), optional `expectedRevision` (positive decimal string), and
1–100 uniquely identified requests. A content request binds `sourceId`,
`assetId`, `collectionId`, `itemId`, `publishedAt`, `expiresAt`; a control request
binds `collectionId`. Both carry `id` and `mode` (`content` or `control`).
Response: `{version:1,generation,revision,decisions:[{id,state}]}` where state is
`active|paused|revoked|expired`. Revision/generation remain decimal strings.
Unknown identity or manifest/generation/revision mismatch is unavailable, never
an active default. Control checks require a known collection and one group;
terminal individual sources do not hide the collection's control/tombstones.

- [ ] Write PostgreSQL tests: closed + frozen handoff authorizes exact retained
  content; prepared/restoring/generation mismatch rejects; original deadline,
  unsend and leave deny; mismatched mapping or duplicate/oversize input rejects;
  expectedRevision rejects any intervening lifecycle change, including repeated
  memberLeft and changes to a lower-revision sibling.
- [ ] Run tests and observe the missing authority failure.
- [ ] Add `legacy_handoffs.revision` and database triggers advancing it on every
  handoff/source mutation. Preserve lock order: runtime, handoff, source for
  mutations that touch both. Repeated group leave increments the fence even if
  sources were already blocked. Restore invalidates old revisions by generation.
- [ ] Implement one bounded SQL statement joining request identities with the
  configured channel, runtime and handoff snapshot. Require frozen or active
  handoff; evaluate original deadlines after query completion as well.
- [ ] Add `/priv/source/retained/check-batch` using the existing constant-time
  Asset caller/token check and 64 KiB body bound. Add HTTP auth, malformed input,
  sanitized failure and routing tests; wire it only with configured runtime.
- [ ] Run full required checks, then commit the complete authority slice.

## Task 2: Current-admin retained group revalidation

**Files:** retained authority/domain tests, management domain/routes tests,
runtime wiring; corresponding Gateway/AdminFE owning changes.

**Interface:** `revalidate` requires the exact manifest, generation, expected
handoff revision and group. Current Account authority supplies the linked LINE
actor; do not trust a user-supplied actor mapping. Reuse LINE member and group
summary checks. Recheck authority before commit and CAS the lifecycle fence.

- [ ] First pin the Account subject-to-LINE contract and management UI caller
  against existing service interfaces; record exact signatures before coding.
- [ ] Write denied-admin/unbound/not-member/bot-absent/restore/concurrent-leave
  tests and a successful closed-mode test where only active, unexpired content
  becomes accessible; terminal state and cleanup stay unchanged.
- [ ] Implement the smallest authenticated management action and audit outbox;
  never modify terminal state, expiry, cleanup or intake/group activation.
- [ ] Add the real caller and verify all owning tests/CI; review with three fresh
  consultants before merge and sequential release.

## Subsequent delivery gates

Asset exact adoption/delegation, independent restore scope, every content path
and shared-reference cleanup; Presenter existing-cache metadata update; full
runtime/secrets and journal custody; external handles' explicit ownership;
single-writer cutover and real group/device acceptance; compatible rollback
window and only then legacy retirement. Each requires owning implementation and
evidence. No complete migration claim from Task 1 alone.

## Execution ledger

- Design round 2: restore fallback and group recovery gaps corrected.
- Design round 3: three fresh reviewers, no actionable findings.
- Source baseline: ad883d0e504f080d05d80b2a15d498a16decc7cd.
- Source refreshed to a196b0242bd5c5d8cb2727941f43fec1171ff236 before code.
- Task 1 implemented locally; 213 PostgreSQL/application tests, 13 browser tests,
  typecheck, format, import boundaries and build pass with no test skips.
- First five retained tests: missing-module failure, then all passed with the
  implementation. Full suite exposed a collision between migration 030 and the
  migration-error test's fixture; reserved fixture step 999 preserves that test.
- Review round 1: SQL and boundary clear; integration found that actual runtime
  readiness rejected closed intake. Added a real configured-runtime/HTTP test
  (503 before fix, 200 after), moved the serving check into runtime and wired the
  real entrypoint. Restoring/missing state/wrong generation still return 503;
  normal content remains rejected. Added actual retained journal restore test.
- Task 2 contract mapping pending. No new runtime admission or Asset adoption.
- Review round 2: three fresh reviewers inspected SQL/lifecycle, real runtime
  routing/readiness and tests; no actionable findings. CI/release remain separate.

## Task 2 contract checkpoint

Account PR #263 resolves a current eligible Admin's linked LINE identity in the
existing private userId authority response. The identity and both generations
come from one Account snapshot. Harness will consume this optional field only
for retained revalidation; absence must deny revalidation without disabling
unbound administrators' existing access-reduction operations.

Implementation must retain the reviewed generation/manifest/revision CAS and
fresh member/bot checks. The owning management caller and audit resource mapping
must be pinned before code: legacy group identity is currently only in each
immutable source manifest, while existing management/audit group IDs refer to
new Harness groups. Do not substitute a source UUID as an unrelated group UUID,
create false activation or label source access restoration as new intake.

Current external prerequisites: Account #263 merged at
20d01ade3046cc486f505062260a2acf3e63e126; CI 43691780385 succeeded.
Account release 43693590696 subsequently succeeded; revision
`account-api--release-43693590696-1` is Healthy and session smoke passed.
Task 2 core is now implemented locally; Gateway/Admin integration remains pending.

### Task 2 design review and selected minimum

Three independent read-only reviewers agreed that leaving terminal rows'
`group_blocked` set would keep collection control permanently paused. Revalidation
must clear the exact group's block metadata on all its rows, preserving terminal
state, immutable deadlines, cleanup and reconciliation fields. Content checks
still deny terminal/expired sources; control can deliver their tombstones.

Ruling: use source-level audit and the existing manifest's exact LINE group
business identity in authenticated management requests. Do not add a new retained
group table, modify normal group metadata or substitute a source UUID as a group
UUID. Two reviewers preferred a separate UUID mapping table for opaque group
links; one recommended source-level audit to preserve existing journal identity.
The selected option avoids a new identity/backfill/restore contract at the cost
of one bounded, batch-inserted audit event per changed source. LINE group IDs are
management data only and must never enter diagnostics or audit metadata.

Pin the owning Audit action and legacy-source UUID grammar before implementation;
existing Harness source audit supports only v4 resource IDs, while the legacy
manifest accepts UUIDs more generally. Use a dedicated retained-source action,
not configure/activate/delete. Do not waive or silently skip audit failures.

Proposed management contract:

- `POST /api/line/harness/admin/retained-groups/search`: strict optional cursor,
  bounded page grouped by exact LINE identity, returning current manifest digest,
  generation and handoff revision as decimal strings plus group metadata/counts.
- `POST /api/line/harness/admin/retained-groups/revalidate`: strict
  `{lineGroupId,manifestDigest,generation,expectedRevision}`; no supplied actor,
  owner mapping or proof hash. Response reports generation, final handoff revision
  and changed-source count.
- Current Account admin authority supplies the linked actor. Fresh LINE member
  and bot-summary checks precede the final transaction. Lock runtime, handoff,
  then sources in stable order; validate exact tuple and completed recovery
  reconciliation; reread Account and compare actor, linked LINE identity and both
  generations before mutation. Source block updates and per-source audit insert
  commit atomically; read the final handoff revision after all source triggers.
- Runtime closed/open and handoff frozen/active only; reject restoring/prepared,
  stale generation, any intervening lifecycle mutation, changed authority and
  unreconciled recovery. No runtime admission, normal-group state or new intake
  changes. Cross-service probes do not atomically lock Account/LINE; a later
  delivered leave still reblocks immediately through the existing event path.
- Gateway/Admin callers must integrate their latest main first, preserve weekly
  changes, add only necessary existing-job verification and distinguish retained
  access revalidation from new-group setup in the UI.

Required additional tests: mixed active/revoked/expired collection control after
revalidation, all-terminal control, repeated leave while already blocked, other
source/global revision races, changed bound LINE actor/generations, recovery
reconciliation, no immutable/cleanup changes, atomic audit failures and UUID
producer/receiver compatibility. The core is now implemented locally; it is not released and the callers remain pending.


### Task 2 local implementation checkpoint

- Account linked-actor response consumed without changing unbound Admin shrink.
- Exact retained list/revalidate POST routes use existing Gateway authentication.
- Same-transaction source block updates and source-level audit preserve terminal
  content, immutable manifest/deadline and cleanup responsibility.
- Audit #65 source `e8150c5ab05610711d61cd4a05085748363365d2`, merged
  `ca8848b5062788ed3789d356caa25074a8ef9eaa`; CI 43697389507 passed.
  Receiver production release is still being verified.
- Critical new tests observed missing-method/route failures before implementation.
  Full local suite: 240 pass, zero skipped; typecheck, format, boundaries and build
  passed. Browser checks, three fresh implementation reviewers and owning caller
  integration are next. No new CI workflow/job, production import, admission,
  LINE switch or legacy retirement.
