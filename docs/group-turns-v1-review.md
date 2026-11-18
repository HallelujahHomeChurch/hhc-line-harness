# Group turns v1 review record

Base: `193118efb73d03e73c4ddb4dd32d764fbaf7ebed`. Reviews are independent,
fresh-context, read-only code reviews with three seats per round: semantics,
authorization/data isolation, and delivery/testing/rollback. Provider/device
acceptance is separate and belongs to the release coordinator.

## Round 1

Resolved findings:

- Pending questions were consumed before delivery and explicit/native-quoted
  answers were not consistently associated. Parent claim now binds actor, turn
  and version; consumption and public child publication share the successful
  delivery transaction. Unknown/invalid output cannot consume it.
- Delayed reset could erase newer context. Reset uses original event time and ID,
  preserves newer jobs, and closes only its actor's implicit continuation.
- Broad name matching rejected date questions. Narrow explicit peer signals keep
  normal questions eligible; native bot quotes do not initially expose tools.
- Clearing the allowlist did not fence queued work. Execution, read and outbound
  paths now reject already admitted v1 jobs while newly explicit calls use the
  old path. Image rollback requires draining those jobs on the new image first.

Regression coverage includes real PostgreSQL and Agent SDK with a synthetic model,
invalid handles, unknown send, competing parent claims, late send acknowledgement,
equal-time delayed reset, cross-actor reset scope and allowlist rollback fences.

## Round 2

Security and delivery seats found no confirmed blocker. Semantics found two
additional boundary cases, both reproduced before correction:

- A confirmed `closed` response left an older awaiting question eligible. The
  delivery transaction now advances a monotonic actor closure watermark. Exact
  quotes can still explicitly reopen the original public turn.
- A legal 46–50-source public turn was discarded by a separate 45-source context
  limit. Public provenance now uses one bounded 256-source limit, preserves the
  required quote/pending turn before background, and reserves a source slot for
  the current question. At essential-provenance capacity, explicit requests get
  a fresh content-free clarification; unconfirmed requests remain silent. No
  model/tool runs and no evidence is dropped to manufacture an answer.

The security reviewer also asked whether bot-answer unsend could invalidate a
parent independently of its sources. The [official LINE FAQ](https://developers.line.biz/en/faq)
states that Messaging API messages cannot be unsent or deleted. That provider
workflow is not supported; user-source withdrawal is supported and invalidates
all copied source dependencies. This is not a claim of a tested bot-unsend API.

## Round 3

Security and delivery seats found no actionable finding. Semantics found two
additional natural-language cases, reproduced before correction:

- "我們星期日可以" incorrectly closed a pending question because a pronoun was
  treated as a definite peer addressee. It now reaches pending/quote decisions;
  cheap peer-name signals require an addressing separator.
- A long public answer lost its concrete final pending question when context
  retained only the prefix. Awaiting answers now retain both a prefix and the
  question-bearing suffix within the same budget. The recipient classifier also
  preserves that suffix instead of truncating it a second time.

Regressions check both group intake/context and actual SDK classifier input.
Round 3's pre-correction full suite passed 307 backend and 14 browser tests; final
checks and a fresh three-seat round follow these fixes.

## Round 4 and final audit

All three fresh reviewers reported no actionable finding. The owner then added a
multi-topic input assertion: when one question was pending, recipient classification
omitted a newer public draft and received only the pending question. The assertion
failed. Classification now retains the pending turn plus at most three recent
public turns, still without tools and within the already bounded authorized
context. Answering another topic does not consume the pending question. A new
three-seat review follows this small final correction.

## Round 5

Security and delivery seats found no actionable finding. Semantics identified a
multi-pending contract gap: a boolean could only consume the preselected newest
question, even when the answer resolved an older named topic. The SDK/PostgreSQL
regression reproduced it. Only when multiple owned, visible pending turns remain,
the structured answer now selects a pending ID or false; the server maps that ID
to its validated version and delivery checks ownership/version again. Unknown IDs
and ambiguous boolean true cannot consume either question. Native quoting narrows
the choice first. No/unique-pending prompts and schemas remain unchanged and no
extra model call is added. Three new SDK/PostgreSQL cases pass before final review.

## Round 6

Security found no actionable issue. Semantics and delivery found two related
edge cases, reproduced before correction:

- Newer long public background could displace an older owned pending question.
  All visible owned pending turns now precede general background and share the
  reserved token budget. Exceeding essential-context capacity uses the existing
  explicit clarification / implicit silence boundary instead of silently hiding
  a pending candidate.
- Two events admitted against the same parent could execute after that parent
  was consumed. A boolean answer now binds to the unique pending target verified
  at execution time, including the model's parent metadata. Delivery receives only
  that validated target and never falls back to the stale intake parent.

The regressions cover long intervening background, two events admitted before
sequential completion, and current parent metadata. Focused suite: 68 passed.

## Round 7

All three reviewers identified the same remaining provenance-capacity branch:
non-parent owned pending turns could still be skipped when their combined source
set exceeded capacity. Every owned awaiting turn now makes that overflow explicit;
none can disappear to manufacture a unique candidate. The bounded notice asks for
a reset and a new explicit call with the key sentence, so old over-capacity pending
state cannot repeatedly trap a pasted follow-up.

Semantics also found priority ordering was reversed rather than chronological.
Context now returns event-time/event-ID order after allocating priority budgets,
so the classifier's recent-three selection actually includes newer public drafts.
Both combined-provenance and newer-draft regressions were reproduced before fixing.

## Validation boundaries

Round 1 fixes passed 303 backend tests with zero skips and 14 browser tests,
typecheck/build/format/import boundaries, all five Python bootstrap/release test
entrypoints, dependency audit and five preserved-plan hash checks. Later-round
checks and final independent review outcomes must be recorded before handoff.

COMMIT-acknowledgement loss is injected after a real PostgreSQL commit; it is not
an actual network partition test. SDK tests use synthetic models and LINE sends.
No local test establishes live-provider latency, two-user LINE/LIFF acceptance,
Presenter permission acceptance, cloud release or production rollback.

## Final round 8 and handoff

Three fresh independent reviewers (semantics, security, delivery) reported no
remaining actionable finding in the approved scope. The final source passed:

- 319 backend tests, zero failures and zero skips, including disposable PostgreSQL.
- 14 browser tests; typecheck, build, formatting and import boundaries.
- All five bootstrap/release Python test entrypoints; production dependency audit
  reported no known vulnerabilities. No dependency versions changed in this PR.
- Five preserved plan hashes match provenance; no workflow or preserved-plan diff.

The source is ready for the coordinator's required CI, sequential merge/release,
configuration readback and separately reported provider/device acceptance. This
implementation review does not claim deployment or user-device acceptance.
