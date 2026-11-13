# Cutover preparation and retirement gates

Status: **preparation only**. Legacy checkout inspected read-only at `08832350d8cd79e849dc658bd37b6f4df6a0a73e`; no legacy code/resource/credential was changed. Real consumers, owners, publication handles, active writers and cloud inventories have not been collected. No gate below is declared passed by synthetic tests.

## Source inventory and decisions still required

| Legacy responsibility | Current consumer / owning boundary | Required disposition before retirement |
| --- | --- | --- |
| helper `find_ppt_slides`, `find_sheet_music`, `find_resource`, `save_resource` | helper users; Graph/catalog/manual publications | Named owner for retained readers, original deadlines and cleanup, or explicit approved stop; not implicitly replaced by group search |
| helper `query_schedule`, `save_schedule` | schedule users; schedule/Notion storage | Named stop or accepted replacement and retention/export decision |
| helper `query_knowledge`, `query_wikipedia` | helper users; knowledge/index service | Explicit stop or accepted replacement; Harness does not fetch arbitrary URLs |
| helper `save_memory`, `retrieve_memory` | personal/group memory | Named retention/read termination/cleanup owner; no migration into the new Agent |
| main `download_weekly_paper`, `update_own_profile` | main users; Account/profile and weekly-paper owners | Separate owner acceptance or approved stop; new group Bot does not replace these |
| Dual binding codes, pending Account challenges, setup announcements, in-flight Reply/model/tool work | AccountFE/AdminFE/AccountAPI/legacy Bot | Cancel and restart old intents; do not translate old approvals; reserved/unknown Reply never replayed |
| Media original bytes, collection/item/root/cursor, ACL and existing Presenter links | Asset/Presenter | Preserve identities and original expiry; verify new-profile compatibility before new writes; no cross-message binary deduplication |
| Download/stage/activate/manual/Graph/catalog unknown effects | Legacy durable work stores + external owning service | Reconcile exact operation/handle against owning metadata; never retry an unknown external publication as a new operation |
| Audit outboxes and operations alerts | Audit and existing Monitor/Action Group | Drain or transfer exact immutable facts; receipt evidence, not log export, proves delivery |
| workers/warmer/catalog-sync/probe/periodic assurance/scaler/queue/CI | Legacy runtime and Azure infrastructure owners | Inventory actual resources and shared dependencies, disable all restart paths after bounded rollback; shared resources retained |
| secrets/roles/LINE channels/webhook subscriptions | Identity, LINE Console and platform owners | Consumer-by-consumer retirement; verify old credential rejection only after successor acceptance and rollback deadline |

Feature inventory comes from `config/profiles.json`; route inventory from `src/media-sync/http-routes.ts`, `src/transport/line/webhook-routes.ts`, `src/transport/http/health-routes.ts`. This is a source inventory, not proof that an endpoint is unused.

| Method | Legacy path | Consumer/disposition gate |
| --- | --- | --- |
| POST | `/api/line/webhook/helper` | LINE helper channel; single-writer controlled handoff |
| POST | `/api/line/webhook/main` | LINE main channel; separate feature/owner decision, never switched implicitly |
| GET | configured health path; configured readiness path (default `/readyz`) | Platform/monitor probes; successor acceptance before removal |
| GET, POST | `/api/line/media-sync/collections` | AdminFE inventory/create; new management path adoption + zero old clients |
| GET | `/api/line/media-sync/collections/:collectionId/status` | AdminFE operations; migration + unknown-work reconciliation |
| GET | `/api/line/media-sync/collections/:collectionId/binding` | AdminFE current binding; new group/version state adoption |
| POST | `/api/line/media-sync/collections/:collectionId/binding/pause` | AdminFE control; preserve policy denial semantics |
| POST | `/api/line/media-sync/collections/:collectionId/binding/resume` | AdminFE control; resume only valid sources, no backfill |
| POST | `/api/line/media-sync/collections/:collectionId/binding/unbind` | AdminFE control; lifecycle ownership survives disconnect |
| POST, DELETE | `/api/line/media-sync/collections/:collectionId/binding-code` | Old dual-code clients; cancel old challenges, remove only after no dependent clients |
| POST | `/api/line/media-sync/collections/:collectionId/work/:workId/retry` | AdminFE operations; unknown side effects require metadata reconciliation |
| GET | `/api/line/media-sync/acl-subjects` | AdminFE subjects; existing Account authority remains |
| PATCH, DELETE | `/api/line/media-sync/collections/:collectionId` | AdminFE collection management; retain non-LINE/shared Asset capability |
| GET | `/api/line/media-sync/collections/:collectionId/items` | AdminFE listing; preserve item/root/cursor |
| PATCH | `/api/line/media-sync/collections/:collectionId/retention` | Legacy retention; new source deadline cannot be overridden |
| PATCH | `/api/line/media-sync/collections/:collectionId/items/:itemId` | Legacy metadata; new-source policy gate remains |
| POST | `/api/line/media-sync/collections/:collectionId/items/retention` | Legacy retention; do not reset original publication time |
| POST | `/api/line/media-sync/collections/:collectionId/items/delete` | Legacy deletion; do not delete shared Asset references blindly |
| POST | `/api/line/media-sync/collections/:collectionId/items/content-tickets` | AdminFE ticket/read path; current source authorization required |
| POST | `/api/line/media-sync/collections/:collectionId/acl` | Legacy ACL addition; no bypass of new preview/group confirmation |
| DELETE | `/api/line/media-sync/collections/:collectionId/acl/:aclId` | Legacy ACL revocation; preserve immediate scoped denial |

Gateway owns forwarding manifests; Asset owns bytes/grants/shared collection endpoints; Account owns user/role bindings; Presenter owns device caches. Removing a legacy upstream never authorizes deleting those services or their shared APIs. Live access logs/client versions and repo consumers must be reconciled against this table before route removal.

## Immutable lifecycle manifest

`pnpm legacy import FILE reviewed-lifecycle-manifest` operates only while the runtime is closed. Required file shape is version 1, one channel and at most 10,000 entries. Each entry has an opaque UUID, exact channel/profile/group/message/source key, original Asset/collection/item IDs (nullable when not applicable), original publication/expiry and policy version, revoked flag, a named non-retiring cleanup owner plus its evidence hash, and external publication handles/outcome. Missing owners, indefinite/unknown expiry or unresolved retention policy block import; do not invent a new 90-day deadline.

A channel snapshot is immutable and repeat import must have the same parsed digest. The importer creates no groups, sources, registrations, binaries or publications. Unsend works even without a new group registration; existing tombstones are applied before import. Expiry preserves the original policy. Leave/member change sets a durable group block requiring owner revalidation; it never silently resumes old content. No automatic legacy writer, reader or external deletion adapter is installed.

The designated retained owner must consume this durable lifecycle state and enforce denial on **every** legacy content path before handoff acceptance. `pnpm legacy status OUTPUT` exports a mode-0600 snapshot of handoffs and sources, including blocks/pending cleanup; protect it as sensitive identity metadata. The owner must prove timely read denial and cleanup, including when the new intake is closed. A local ledger is not remote enforcement. Without this owner integration/acceptance, do not activate or retire the legacy service.

Unknown publication outcomes stay unknown until `pnpm legacy reconcile SOURCE_ID PUBLICATION_INDEX RESOLUTION_FILE` records exact `present` plus handle, or verified `absent`, with an immutable owner evidence hash. It never issues a publish call. `deny SOURCE_ID confirmed-source-denial` records denial; `ack-cleanup SOURCE_ID REVISION EVIDENCE_SHA256 owner-verified-all-handles` accepts only a current pending revision with every unknown effect resolved. A receipt means the operator has verified every original/publication reference; it is not produced by this tool. Pending/unknown metadata is never age-pruned.

## Single-writer handoff and rollback

1. Complete the inventory and immutable manifest with owner evidence. Close new intake. Stop/fence old webhook intake, workers, leases, scaler and CI restart paths; drain or reconcile external effects. One channel has one writer; copying the DB does not fence old cloud credentials.
2. `pnpm legacy freeze DIGEST WRITER_EVIDENCE_SHA256 all-legacy-writers-fenced` records the operator's external fencing evidence. Evidence hashes refer to separately retained approved records; their format alone does not prove reality.
3. Reconcile unknown effects. `pnpm legacy activate DIGEST EVIDENCE_FILE reviewed-consumer-and-owner-evidence` requires `consumerAcceptance`, `intentsCancelled`, `externalEffectsReconciled`, `compatibleRollback` evidence hashes. It only advances the local handoff; it does not change a webhook, open admission or activate groups.
4. Only after separately authorized deployed consumer acceptance and the actual single webhook switch may admission open. A database trigger blocks opening while any recorded handoff is incomplete or on a different runtime generation. Fresh group announcement remains required.
5. On failure, stop new intake and preserve lifecycle service. Roll back only to a compatible artifact that recognizes new sources and current denial state, never to an old writer that ignores the new profile. Do not replay unknown Reply/publication effects or extend expiry.
6. Recovery journal version 2 includes legacy manifest/denial/reconciliation metadata. Restore resets every handoff to `prepared`, blocks groups, and invalidates old operator attestations; reverify the single writer before admission. Version 1 journals are intentionally rejected by this unreleased version.

## Retirement completion

`pnpm legacy retirement-check EVIDENCE_FILE` reports blockers and returns nonzero until handoff, unknown publications, pending cleanup, rollback deadline and all evidence fields pass. Required evidence: `featuresDecided`, `consumersMigrated`, `lifecycleOwnersAccepted`, `outboxDrained`, `restoreAccepted`, `legacyCredentialsRejected`, `legacySchedulersDisabled`, `productionAccepted`, plus `rollbackUntil` in UTC.

This is a checklist validator, not authority to revoke credentials, disable jobs or archive repositories. A passing synthetic fixture is not actual retirement. Keep old code/resources and clean unmerged worktrees until real acceptance, explicit scope and bounded rollback are satisfied. Presenter releases remain Ray's responsibility.
