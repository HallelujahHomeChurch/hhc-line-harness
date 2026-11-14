# Group management

The Account site retains its existing login/MFA/LINE linking, cancellation and account-switch flow. Account linking never activates a group. The Admin site admits the current canonical `admin` role; delegated legacy media permissions or wildcard permissions cannot substitute for that role.

Gateway `/api/line/harness/admin/*` routes are human-only, on the Admin production host, with a dedicated credential that defaults absent. They strip untrusted identity and private service headers. Harness repeats current Account authority checks, accepts actor identity only from this boundary, and rejects caller-selected actors. No credentials or real webhook ownership are configured by this implementation.

A signed group interaction creates an opaque short-lived setup reference. Website continuation derives the original LINE actor from that reference and requires the same currently bound Account Admin. Unbound continuation shows binding instructions only. Role remove/re-add, unbind/rebind, account changes, expiry, group mutation or runtime generation changes invalidate old approval. Saving settings is a draft, not activation or publication readiness.

Collection creation persists an actor-bound operation before calling Asset; retry uses the same key and name. Empty collections grant no reader access. A setup selects one destination and optionally one new reader, resolved through Account's existing audited directory. Reader identity and label come from Account, not browser labels. Group preview and confirmation recheck authority, membership, ACL and binding. Only a confirmed single-attempt Reply announcement permits the Asset ACL CAS and final local activation. Ambiguous announcement or ACL results remain closed; never replay a Reply to repair an unknown result. Start a fresh preview to approve current metadata.

Revocation is a website shrink operation available to a current Admin without LINE binding. Confirmation first commits sharing disabled and an applying operation, then calls Asset outside database locks. Retry reuses the same persisted operation and expected ACL revision. The remaining audience is restored only after exact Asset metadata, current Account authority and unchanged group/runtime fences match. Changed policy or unknown result remains closed. Pause/delete share the same domain commands with LINE private management; interaction leases fence late commands. Deletion closes policy immediately and uses bounded cleanup batches.

Direct chat exposes paginated group status, valid/failed counts and deterministic pause/delete previews only. Unbound users receive a fixed binding link; bound non-Admins receive a fixed explanation. No chat messages, filenames or original bytes are available through management. Content access remains the independent current-LINE-member protected path.

Stopping Presenter sharing preserves valid originals/publications for later reapproval. Changing destination closes the old destination and queues publication removal; it never migrates historical files. Previous collection reservations remain until unknown publications are resolved. Source deadlines never extend and inactive intervals are never backfilled.

Local evidence lives in the task ledger and ignored `.artifacts` logs. These tests do not establish real LINE announcement, device, CI or production acceptance. LIFF content/search UI is delivered with the search vertical, separately from website management.

Group deletion becomes terminal only after every source is denied and its
cleanup, publications, orphan references and pending jobs are reconciled. A
fresh current Admin who is still a group member can then start setup again;
this advances the group revision, clears its old destination and requires a new
preview plus original-group Reply announcement. Old source state, tombstones
and approval revisions are retained; no old content is restored automatically.

Draft collection reservations are reclaimed on a later configuration attempt only when no current approval, active binding, pending original/publication or unknown announcement can still own them. Collection-scoped transaction locking serializes reclamation with configuration and announcement. Unsent, expired or superseded drafts alone do not reserve a collection forever.
