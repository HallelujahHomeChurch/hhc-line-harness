# Audit and operations delivery

Local implementation only. No credential, Alert Rule, Action Group, production
route or webhook has been changed. Planning revision:
`73ee1af2a1ff828d72421a73626f45ff4ce04a6f`.

## Audit

The existing in-process background scheduler drains the transactional outbox.
There is no new delivery service. Each saved configuration, activation, pause,
delete request and ACL revocation writes a fixed UUID and exact Account actor in
the same PostgreSQL transaction as its business transition. `configure` is a saved
draft; `delete` is the logical denial/deletion request, not proof of physical
cleanup. `acl_revoke_requested` is a local deny intent, never external success.
Only the reconciled final ACL result writes `acl_revoke`.

The independent producer is exactly `hhc-line-harness`, with its own private HTTPS
`AUDIT_HARNESS_TOKEN` / receiver `AUDIT_TOKEN_LINE_HARNESS`. The origin must be HTTPS,
redirects are denied, requests are bounded to two seconds. Set both origin and
token together; neither means local-only accumulation, visible as
`auditConfigured=false`. Credential reuse with other configured private harness
credentials fails startup. Receiver private HTTPS admission also rejects tokens
shared with another producer. No raw LINE identity, text, filename, link or model
output is in the closed event. The exact receiver fixture is checked in alongside
this document. Deploy/admit the receiver catalog first, then matching Asset and
Harness producers. The legacy producer and old outbox remain unchanged.

Claims use row locks, a ten-second lease and incrementing fence. The canonical
payload is persisted before HTTP and is immutable with the original fact. An
unknown response is retried with the same event ID/payload; only explicit
`accepted`/`duplicate` counts as delivered. Conflicts and schema denials are dead
letters. Retry delays are 30 seconds, 2/5/15 minutes, 1 hour, then 6 hours. Twenty
failed attempts become dead letters, except 401/404 remain pending during receiver
adoption/credential recovery. Business commits survive a remote Audit outage.

After fixing the receiver/configuration, inspect the original event and run the
local operator command `pnpm operations audit-retry EVENT_UUID retry-identical-fact`
with task/environment-specific DB access. It never edits the event, manufactures
success or sends HTTP itself. The normal dispatcher retries it. Do not replay
business actions to repair Audit delivery. A conflicting receiver fact requires
an incident investigation; repeated retries cannot replace append-only facts.

## Status and existing alert channel

`pnpm operations status` reads the configured `LINE_CHANNEL_ID` and emits bounded
counts only. Runtime emits `line_harness_health` once per minute and a fixed
`line_harness_intake_persist_failed` event for durable intake failure. Readiness
checks the necessary DB and open admission mode; liveness is process-only. No
public endpoint exposes operational counts or credentials.

Snapshots include oldest pending download/index ages, original completed/failed/
pending counts, known failed sources, cleanup/unpublish backlog, actual reclaimed
worker leases, Reply unknown/expired, Audit backlog/age/dead letters, pending cost
alerts and the last 24 provider/month cost rows. Counts cover retained records;
they are not lifetime totals or a certified real-world success rate. Compute
original completion rate from completed versus completed+failed, separately from
pending work. Missing snapshots/DB failures mean unknown, never healthy.

Use the existing Azure Monitor console-log ingestion and existing service-health
Action Group owned by `azure-infra`. The queries below are reviewable inputs for
that owner; they are not provisioned resources. No Operations API notification
endpoint or LINE Push was added.

- `operations-health.kql`: Alert on intake failure, original/index delay >5 minutes,
  deletion backlog, Audit dead letters/age >5 minutes, Reply unknown, or missing
  configured Audit. Review held/paused work separately.
- `operations-budget.kql`: Group first threshold/overrun events by persisted
  `alertId`; use a stateful rule/dimension to suppress duplicate notifications.
- `operations-stale.kql`: Missing heartbeat beyond 6 minutes for an expected active
  replica is unknown. Join platform replica lifecycle before alerting on stopped
  replicas. The query is service-level; per-replica adoption needs the runtime's
  actual replica field verified before release.

Budget threshold crossing is persisted once per provider/month/kind. A worker
exports the same content-free alert ID with a lease and retries hourly. Export
success is **not** proof of Monitor ingestion or recipient delivery: it remains
pending in status. After verifying the actual Monitor alert/receiver receipt,
record the evidence in the rollout ledger and run
`pnpm operations alert-ack ALERT_UUID azure-monitor-confirmed`. This explicit
operator acknowledgement is the delivery completion boundary; missing/unverified
routing never silently clears a pending alert. Emitter failure retains the lease
and retries. Azure keeps serving above $100; OpenAI's $500 hard admission limit
is independent of alert transport.

## Admission evidence still required

Before real intake: independent secret wiring and receiver checksum; private
transport rejection tests; synthetic event accepted and duplicate deduplicated;
Monitor rules adopted through the owning infra workflow; alert receipt and
acknowledgement; missing heartbeat detection; provider billing reconciliation.
Local tests use synthetic events and disposable PostgreSQL only. No live
notification or Audit acceptance is claimed.

Confirmed source descriptions and deletions also write fixed-ID facts in the same
transaction. `line.source.description` / `line.source.delete` target the Harness
source UUID and record only its relevant revision plus authority kind. Verified
LINE authors use the Audit contract's `anonymous` empty actor with `line_author`;
website Admins use the real Account UUID with `website_admin`. No LINE IDs,
filenames, description text or original content enter these facts. Recovery
preserves both forms and the existing immutable outbox delivery rules.
