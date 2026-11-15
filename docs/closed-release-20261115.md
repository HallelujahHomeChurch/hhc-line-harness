# Closed release implementation

This implements the approved staged migration. Foundation PR #225 is applied;
the database lock was restored and existing Apps/Jobs remained unchanged.
It does not establish LINE/device acceptance or authorize early retirement.

## Scope and ownership

- Reuse PR CI as a callable main verification job. It must run every test/security
  gate on main and export the exact tested Linux image as an immutable artifact.
- A manual main-only workflow in repository ID 1456180919 publishes that artifact
  with the dedicated publisher identity; a separate production-environment job
  uses the deployer. Neither identity acquires additional permissions here.
- Only `hhc-line-harness-api` and manual `hhc-line-harness-migrate` in resource
  group `hhc-line-harness` are deployed. API uses 0.25 CPU/0.5 GiB, one replica;
  migration uses the same limits, one execution/replica, no retries, 300 seconds.
- Pin secret versions in Key Vault. API and migration use distinct DB logins and
  identities. The retained helper channel secret is copied securely into its
  dedicated slot, without rotating the old channel or token.
- Keep HARNESS_ENABLED, AGENT_ENABLED and EMBEDDING_ENABLED false. No worker,
  scaler, webhook change, group activation or legacy shutdown in this stage.
- Deploy migration first, require its exact execution to succeed, then deploy
  the private API. Validate preview scope and actual digest/identity/configuration
  and readiness. Failure preserves the legacy writer; do not downgrade the DB.

## Implementation and verification

1. Add failing tests for artifact provenance, deployment scope, pinned secrets,
   private ingress, disabled admission, resource limits and preview rejection.
2. Implement the single-image handoff and narrow closed-release renderer/runner;
   add the callable CI and manual workflow. No application behavior changes.
3. Run full PostgreSQL tests, typecheck, format, build, browser/image smoke and
   the new release checks. Three fresh independent reviewers per round; fix and
   repeat until no actionable findings, then required hosted CI before merge.
4. Bootstrap dedicated DB logins/privileges and exact secret slots through the
   owner path. Runtime roles cannot own schema, create objects or modify migration
   history. Cap API connections at 16 (two revisions), worker at 3, migration at 1.
   Bootstrap vector before the unprivileged migration role runs.
5. Release merged source through the manual workflow. Record source, run, artifact,
   registry digest, execution, revision and observed readiness separately.

## Later gates

Full lifecycle runtime, service caller credentials, recovery journal custody,
actual LINE membership/announcement and Asset contracts precede intake. Retain
the Taiwan proxy. Audit actual legacy sources and unknown operations before
single-writer handoff; preserve IDs/deadlines and verify cleanup ownership.
Only accepted cutover and the bounded rollback window permit legacy archival.
Presenter package/tag publication remains user-controlled.

Azure Container Apps does not expose a read-only-root setting in the selected
2025-07-01 resource schema. Docker's read-only image smoke is local evidence;
do not claim that mount policy is enforced by ACA. Runtime remains nonroot and
content intake stays disabled in this stage.

## Configured runtime release

The same manual workflow accepts `serving=true` after peer credentials and Asset policy are ready. `LINE_RUNTIME_IDENTITIES` pins the helper destination as both LINE channel scope and bot ID, the existing LINE Login channel, and the independently verified runtime generation. `RUNTIME_SECRET_URIS` supplies exact versioned Harness secret slots; secret values never enter workflow variables. The API remains private and the event worker consumes only `hhc-line-harness-wakes`, at most one execution with its own three-connection role. API credentials are not provided to the worker. Agent/embeddings remain disabled.

This option does not open database admission, change the LINE webhook, import old sources or retire their cleanup owner. Migration refuses a configured API or enabled/undrained queue worker; stop/drain writers through the existing recovery procedure before later schema releases. Human LINE/mobile/Presenter acceptance follows the usable deployment; the old version and cleanup responsibilities remain available during rollback.

## Original model and embedding wiring

The model follow-up completes the original plan's runtime wiring: OpenAI `gpt-6.1-terra` through the preserved OpenAI-only Taiwan CONNECT proxy; the existing Azure `hhc-bulletin-ai` deployment as fallback; and the existing Azure `text-embedding-3-small` deployment at 1536 dimensions. No Azure model deployment or capacity is changed. Existing credentials are copied to dedicated, versioned Harness slots without rotating the legacy channel/provider credentials.

The dedicated embedding identity can read only the Harness API database secret, pull the image and invoke the existing Azure resource. It cannot read LINE, reply, Account, Asset, Gateway, Audit or OpenAI secrets. Its separate scheduled job runs every 15 minutes, with one replica, no platform retry and a 660-second limit. The embedding pool uses at most three connections; with the API's eight, the shared 16-connection role retains headroom. The original-download worker retains its separate role and has no model credentials. Migration refuses either enabled or undrained background job.

The new database had no imported legacy sources at initial admission. This schedule indexes only new Harness sources; legacy Graph/media cleanup remains with the old service. Enabling an embedding provider does not bypass the existing index evaluation/activation gate or claim real-corpus retrieval quality. Human group/mobile/Presenter acceptance follows deployment.

Pricing snapshot checked 2026-11-15: [OpenAI standard pricing](https://developers.openai.com/api/docs/pricing) gives Terra input/output/cached/30m-write/12h-write of USD 1/5/0.05/1.25/2.50 per million tokens. [Microsoft's Global Standard Terra table](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/gpt-6-1-terra-now-generally-available-in-microsoft-foundry-build-agents-that-see/4567769) confirms short-context input/output/cached/write at USD 1/5/0.05/1.25. The existing bounded run stays below the long-context tier. The embedding input snapshot is USD 0.02 per million tokens. Provider smoke, identity readback and semantic-index state must be reported separately from source tests.
