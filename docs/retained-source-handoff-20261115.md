# Retained-source handoff before helper cutover

This implementation correction closes the retained-owner requirement in
`cutover-retirement.md`. It does not change the five preserved source plans.
It is a design, not production adoption or retirement evidence.

## Decision and boundary

Use an explicit Asset-owned adoption record for each retained LINE source.
Preserve its original asset, collection and item IDs, ETag, uploader provenance,
scan evidence and exact original expiry. Do not convert scanned legacy assets
to the new unscanned profile, reset their publication time, or extend them to
90 days. Harness owns LINE lifecycle decisions; Asset owns bytes, ACLs,
immutable deadlines and physical cleanup. No cross-service database access.

Alternatives considered: existing delete APIs reject the new owner, while
copying the legacy caller credential would erase the identity boundary. Reusing
source-policy v1 would misrepresent scan state and expiry. Keeping the old bot
as the cleanup owner would leave the requested retirement incomplete. A
separate adoption association is therefore the smallest complete approach.

## Exact adoption, separate from provenance

The operator prepares a private, immutable adoption manifest from authoritative
Asset metadata and the reviewed Harness legacy manifest. It binds the legacy
manifest digest, source ID, asset ID, collection/item IDs, ETag, original owner,
namespace, item publication time, actual expiry, retention exemption/policy and
expected collection/ACL revisions. Shared references and external publication
handles are enumerated before accepting a row.

Asset admits only the dedicated verified Harness principal and an explicitly
configured digest of that exact adoption document. A bounded private operation
validates the entire document and applies one transaction per collection with
CAS and idempotent replay. Partial collection inventories, changed content,
unknown outcomes, conflicting mappings, expired-to-active resurrection and
deadline extension fail closed. A collection cannot be handed off while an old
writer can still mutate its publications or retention. Clear the temporary
adoption admission after the exact manifest has been accepted.

An Asset side table records lifecycle delegation. Original `owner_service` and
`created_by_service` remain provenance; authorization to manage an adopted
collection is explicit and scoped to that association. Old mutations of the
adopted collection are fenced. Unadopted collections retain existing behavior.

The adopted collection and original-asset scope, manifest digest and custody
generation are also pinned outside the Asset database in the reviewed runtime
configuration/recovery record. Every scoped read must require a matching local
association; an absent row never means "never adopted". Asset-only restore,
Harness-only restore and mismatched backup times keep this exact scope denied
until both owners reconcile against that independently retained record and the
current denial journal. The restore gate must apply before ordinary-reader
fallback, including direct original/grant paths. Unrelated assets stay outside
the scope. A rollback may not remove this guard or downgrade to an unaware image.

## Reads, control and cleanup

Harness exposes a separate authenticated retained-source check backed only by
its `legacy_sources` and handoff state. Requests bind the exact immutable
manifest identity, source/asset/item mapping and deadline. A monotonic handoff
revision fences multi-item reads across revocation. Closed intake continues
serving lifecycle decisions; restoring or unverified generations fail closed.
No new group registration is required to receive an old-message unsend.

A current Website global Admin may request retained-group revalidation through
the authenticated management path. Harness must freshly verify the linked LINE
actor's membership and the bot's presence in that exact group, current Account
authority, the handoff generation and the expected group/lifecycle revision.
Clear only that group's block in a CAS transaction after those checks; any
concurrent leave, restore or authority change rejects the attempt. This operation
does not open intake or activate a new group, and never changes revoked/expired
state, immutable deadlines or pending cleanup. Recovery reconciliation must
finish before a revalidation can succeed. Record the decision in the audit
outbox; do not accept an operator's opaque evidence hash as membership proof.

Asset checks its local deadline before and after external authorization. Only
adopted rows call the retained-source authority. Failure, missing mappings,
withdrawal, group block and stale generations deny access without weakening
the original scan and ACL rules. Unrelated legacy collections, weekly bulletins
and livestreams acquire no Harness or Account dependency.

The common enforcement path covers collection discovery/items/changes/content,
new and previously issued tickets, grants, private original reads, HEAD, Range
and 304 responses. Unverifiable old tickets are revoked precisely at adoption.
Cleanup reuses Asset's transactional item tombstone and reference-aware soft
deletion; a collection withdrawal cannot blindly delete a shared original.
Acknowledgement follows actual owner readback, never the existence of an
outbox entry or a syntactically valid evidence hash.

Adoption advances collection/item metadata revisions without changing identity
or resetting cursors. Existing Presenter caches must learn the original expiry
and current control policy through the compatible consumer before cutover.
Content and control authorization remain distinct. A device that cannot enforce
the policy blocks acceptance; publishing an installer remains owner-controlled.

## External handles and old feature disposition

Inventory manual/Graph/catalog publications separately from Asset publications.
Asset adoption cannot attest to their withdrawal or deletion. Each exact handle
needs a non-retiring owner with original-deadline and denial enforcement, or an
explicit owner-approved disposition. Do not delete or adopt a preexisting shared
document library merely because the old bot indexed it. Old resources, schedule
memories and text memories are not imported into the new Agent. Preserve them
under their existing retention/export decision and do not invent acceptance.

## Verification and release order

1. Add failing boundary tests for wrong/partial manifests, replay and CAS races,
   unchanged scan truth, original expiry, shared references and old-writer fences.
2. Implement the Asset side table, exact adoption/cleanup authorization and
   common reader checks; test unrelated services with Harness and Account down.
3. Implement Harness retained-source decisions and bounded cleanup delivery;
   test unsend, leave, closed intake, recovery generation and multi-item races,
   plus Admin revalidation and revoked/expired rows remaining denied afterward.
4. Test Presenter cache transition using existing control/deadline contracts,
   including offline expiry and existing root/item/cursor identity.
5. Three independent reviewers inspect each change; fix and repeat until no
   actionable findings remain. Run owning database, image and consumer CI.
6. Release compatible owners with adoption closed; configure only new dedicated
   credentials and exact identities through each service's release path.
7. Fence old writers, reconcile exact effects, import and adopt the immutable
   manifest, validate real denial/cleanup and Asset-only/mismatched restore
   fencing against the independent scope record, then switch the single webhook.
8. Perform current-admin group setup and real provider/device acceptance. Keep
   a compatible rollback artifact and lifecycle owner until the bounded rollback
   window closes; only then retire old scheduler/credential paths and archive.

Open evidence gates: authoritative external-handle ownership, actual consumer
versions, independent restore-journal custody and real group/device acceptance.
No operator attestation may be manufactured to satisfy these gates.
