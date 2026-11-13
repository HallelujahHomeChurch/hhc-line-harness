# Recovery and release contract

Status: local implementation and disposable fixtures only. Nothing in this document authorizes production restore, admission, deployment or cloud changes.

## Recovery invariants

The database backup alone is insufficient to reopen service. A current signed policy journal must survive outside that backup, with an independently recorded minimum coverage timestamp and generation. Its HMAC key must be stored separately. Missing, stale, mismatched or unverifiable evidence leaves intake and reads closed. Production journal storage, custody, freshness monitoring and an owner remain deployment prerequisites; the local CLI does not provision these.

Journal version 2 additionally carries immutable legacy lifecycle identities and reconciliation state; version 1 is rejected. The journal contains IDs/revisions, immutable expiry, denial/tombstone metadata, exact publication identities, model costs/reservations and Audit/alert facts. It contains no message bodies, filenames, Reply tokens or provider conversations. It is still sensitive metadata. Limit: 64 MiB, 100,000 rows per source/group/publication/tombstone/Audit list, 240 provider-month rows. Exceeding a bound fails export; there is no partial journal.

1. Close intake/read admission with `pnpm recovery quiesce stop-intake-and-reads`.
2. Stop and drain **all** API, download, embedding, cleanup and outbox writers. Disable their scaler/restart paths. Closing the API is not sufficient to stop in-flight external effects. Record a current owner-confirmed coverage timestamp and a generation above every previously issued generation.
3. Export `pnpm recovery journal PATH all-writers-stopped` using `DATABASE_URL` and separately supplied `RESTORE_JOURNAL_KEY`. The file is created once with mode 0600. Preserve it outside the database backup. The acknowledgement string is an operator assertion, not process-discovery automation.
4. Restore into an isolated database while every serving process remains stopped. Run the immutable artifact's additive migrations. Never expose a restored snapshot directly.
5. Run `pnpm recovery restore PATH NEW_GENERATION MINIMUM_AS_OF reviewed-current-journal`. Validation failure leaves admission closed; reconciliation failure leaves `restoring`. Retry only the identical journal/generation after correcting the cause. Do not manufacture an earlier minimum timestamp to accept a stale journal.
6. Inspect policy, costs, pending external work and Audit/alert facts. Sources lacking current exact identity/revision/deadline proof are denied and queued for reconciliation. Unknown publication outcomes are not replayed. Removed/expired sources never become ready. Valid original content keeps its original deadline. Groups remain paused; fresh current-admin and group confirmation is required to resume.
7. Deploy every process with `HARNESS_RUNTIME_GENERATION=NEW_GENERATION`. Startup rejects old generation pins. Verify the source callback and Asset policy compatibility before `pnpm recovery admit NEW_GENERATION JOURNAL_SIGNATURE verified-policy-and-generation`.

No old Reply, model/tool step, encrypted result or vector document is replayed. Old model calls are settlement-fenced: aggregate charged/reserved costs cannot decrease or be charged twice by a late pre-restore response. Unknown cost remains reserved pending provider billing reconciliation. The journal does not reconstruct original content or arbitrary post-backup business data. Actual billing reconciliation and remote publication cleanup need separate owner evidence.

## Retention

Each sweep has bounded batches. Reply/interaction payloads use their expiry, conversation checkpoints use 30-minute idle expiry, query results/tool content use their short TTL (24 hours for model steps), and acknowledged Audit/terminal metadata use a 120-day horizon. Durable unknown operations and cost records remain for reconciliation. Registration/configuration ownership metadata is not conversation content.

Source content is cleared on denial; physical source rows are pruned only after original publication plus 120 days and confirmed cleanup of every publication/orphan with no pending references. Tombstone/receipt pruning also requires a monotonically advanced ingest floor, so old LINE events cannot recreate content. These are local lifecycle policies, not permission to delete cloud objects or change Asset retention.

## Immutable artifact and compatible rollback

The Docker build uses locked official dependencies and Node 26.13.1. The runtime is the published nonroot Distroless Node 26 Debian 13 image pinned by digest; no package manager, shell or build tools are shipped. API runs with a read-only root and bounded writable `/tmp`. Document extraction also uses Node permissions, bounded bytes/time/heap and no network. Production CPU/memory/scaler settings still require platform acceptance.

PR CI classifies Markdown-only changes, verifies original-plan provenance and keeps the required `verify` gate. Code/configuration changes run type/format/import-boundary tests, PostgreSQL and browser tests, full-history secrets scan, dependency audit, image smoke and high/critical image scans. A failing security gate cannot be waived by the deployment path.

A future approved main release must build once, record source commit plus immutable image digest, and deploy that exact artifact through CI/CD. The private HallelujahHomeChurch/hhc-line-harness repository now exists. Its initial main contains only the GitHub-generated README; application code is delivered through a PR. No deployment environment has been provisioned, and there are no guessed release credentials or ad hoc production deployment commands. Creating that approved release path and branch protection is a prerequisite to first admission.

Migration order: verified backup/current policy journal → all writers stopped → additive checksum-checked migrations → compatible consumers (Account, Asset, Audit, Gateway, websites, Presenter) → closed Harness → contract/probe checks → explicit admission. API and each worker are independent acceptance units. No source or worker is enabled by migration itself. Database downgrade is not a rollback strategy: preserve schema/policy and return only to an artifact that understands the new caller/profile, source deadlines and generation. Otherwise stay closed with the last healthy compatible lifecycle service. Never run an unmerged artifact against production.

## Local evidence and limits

`tests/recovery.test.ts` performs a real `pg_dump`/`pg_restore` of its own random disposable schema with simulated 30-day age, current tombstones/costs/Audit/alerts and stale-worker fencing. `tests/retention.test.ts` verifies expiry/redaction and confirmed cleanup requirements. `tests/load.test.ts` measures 500 synthetic local ingestion transactions with eight concurrent callers plus duplicate replay. It does not measure real webhook, cold scaler, LINE or provider latency.

`scripts/image-smoke.py IMAGE` owns and removes its isolated containers/network; it checks migrations twice, nonroot read-only API startup, health/readiness, network-isolated extraction and graceful shutdown. Real backup custody, disaster RPO/RTO, multi-replica deployment, device behavior, external queue wake and provider billing remain external acceptance gates.

Closed admission continues persisting authenticated unsend/leave/memberLeft denial events without admitting new content. Expiry, cleanup and unpublish maintenance continue in closed mode; ordinary processing and new publication remain stopped. Restoring rejects database writes: ingress must remain with an independently durable lifecycle owner during the all-writer stop and isolated restore, and that owner must reconcile its latest denials into the external policy journal before admission. A database restore alone cannot recover unobserved LINE events; do not switch the webhook to the isolated restoring service.
