# Retained group access management

The existing private management transport admits only the exact Gateway token,
Account user principal and current Website Admin. Retained management does not
register a new group, activate intake or change original retention deadlines.

- `POST /api/line/harness/admin/retained-groups/search` accepts only an optional
  `cursor` (exact LINE group ID). A page contains at most 20 groups with
  `lineGroupId`, nullable live `displayName`, `sourceCount`, `blocked` and
  `publishedFrom`/`publishedTo`. It also returns `hasMore`, the next `cursor`
  when needed, and `generation`, nullable `manifestDigest`/`revision`, and `ready`.
  Missing LINE names do not hide retained responsibilities. An unbound current
  Admin can inspect metadata. Exact LINE group IDs are private management data;
  never include them in diagnostics, audit events or URLs.
- `POST /api/line/harness/admin/retained-groups/revalidate` accepts exactly
  `{lineGroupId,manifestDigest,generation,expectedRevision}`. Generation and
  revision are positive int64 decimal strings, never JavaScript numbers.
  Success returns `{generation,revision,changedSourceCount}`.

Revalidation requires a current bound Admin's linked LINE actor from Account
PR #263, fresh membership and bot summary checks, and an unchanged Account
identity/binding/Admin generation at commit. Runtime must be closed/open, the
handoff frozen/active and in the same generation, and any recovery record must
be reconciled. The database lock order is runtime, handoff, then sources ordered
by ID. Any intervening source/handoff mutation invalidates the global revision,
including another group's mutation and a repeated leave while already blocked.

Only the exact group's block metadata and source revisions change. Revoked and
expired sources remain denied, with manifests, cleanup and reconciliation facts
untouched. Clearing terminal rows' block metadata lets collection control deliver
tombstones. Already-unblocked groups are a verified no-op with no new audit fact.
Changed sources and their `line.source.retained_revalidate` audit outbox facts
commit together. Source IDs remain the original PostgreSQL canonical UUIDs; no
new retained-group identity or restore mapping is introduced.

Account and LINE probes do not atomically lock those external services. A leave
not yet delivered or authority revoked after the last check cannot be predicted;
subsequent lifecycle events immediately block access again. Provider failures
fail closed. HTTP returns 403 for missing current Admin/binding/membership,
409 for stale state and 503 with a fixed error for dependency failures.

Audit receiver PR #65 must be released before enabling the new producer. Its
producer fixture is pinned here; no credential or runtime admission is included.
Gateway must explicitly admit both POST routes, and Admin must present retained
access separately from new-group setup. Their integration/release and real
provider/device acceptance remain separate gates; these source tests do not
establish cutover or legacy retirement.
