# Group turns v1 — implementation and release handoff

Scope: the approved 2026-11-18 product plan and six review corrections. The
preserved five original plans are unchanged. This document records source
implementation, not LINE device or production acceptance.

## Ownership and rollout

PostgreSQL remains the only durable owner. API conversation failures do not add
an Asset, Account, or model dependency to the download/cleanup workers. No Push,
OneDrive/YouTube tools, new workflow, or shared infrastructure is introduced.

`GROUP_TURNS_GROUP_IDS` is an optional comma-separated allowlist of internal
Harness group UUIDs (max 20, unique; default empty). Pass it in the existing
`LINE_RUNTIME_IDENTITIES` release configuration. The existing renderer forwards
it only to the API. Start with the already admitted test group. Clearing the
allowlist restores explicit-mention intake. The previous verified image can
ignore additive migration 031. Do not undo that schema or reset group/ACL data.
Private pickup does not echo a user's result into the group, regardless of the
allowlist. With LIFF configured, it offers an authenticated private result page;
without LIFF it offers only a content-free notice.

## Public delivery proof

Generated jobs and private checkpoints do not establish public history in enabled
groups, even for the original speaker. `Deliveries` encrypts the prospective turn,
reserves the one send, and accepts only validated LINE sent-message IDs. Exactly
one `attempt_reserved -> delivered` update and the public turn insert share the
same PostgreSQL transaction. Missing IDs, ambiguous external calls, or cleanup
that already marked the send unknown cannot publish a turn. Lost COMMIT
acknowledgement is read back on a fresh connection; no send is repeated.

The delivery UUID is the public turn's unique key, not a foreign key to the
short-lived delivery row. Old-image receipt cleanup can therefore continue while
public history remains referenceable. Turns expire no later than their question
or any source dependency; source withdrawal erases encrypted derived text. Every
reuse checks group/runtime generation, current membership, current source
revision/description revision, and deadline. Presenter ACLs stay independent.

## Routing and context

Cheap intake signals distinguish direct calls, explicit peer addressing, native
quotes, personal pending questions and references to public drafts. Ordinary
peer statements do not enter a model job. A public answer's identity can be looked
up beyond the latest 20 turns; an actor's pending question is similarly prioritized.
Pending answers bind group, actor, parent turn, version and delivery ID. A
structured `answersPending` decision is accepted only for the original owner's
awaiting turn. For multiple owned visible pending turns, that same structured
output selects the actual pending ID or false; the server supplies its validated
version. Unknown IDs and ambiguous boolean true are rejected. Native quoting
narrows the candidates; no/unique-pending calls retain the original boolean
schema and prompt with no extra model request. Sending reserves the parent; only confirmed delivery consumes it,
atomically with the public child insert. Invalid output, unknown sends and late
acknowledgements cannot consume or replace a newer answer. Terminal unknown claims
can be reclaimed. A delayed peer event cannot consume another actor's question. A confirmed closed
reply advances only that actor's closure watermark in the delivery transaction;
an unknown or older reply cannot close a newer topic.

Explicit calls retain one ordinary Agent run. Strong implicit continuations use
one tool-free structured response; they can answer directly or request retrieval.
Only that confirmed retrieval decision permits a subsequent tool-enabled run.
Ambiguous candidates first use a bounded, tool-free recipient decision over a
small authorized context. Classifier and answer share one BudgetModel ordinal
sequence. A silent result is normalized to no answer, no evidence, closed
follow-up; it cannot send, publish, checkpoint or consume a pending question.
Unconfirmed failures and slow processing remain silent, without a waiting hint.

The context is bounded to approximately 2,000 tokens and 20 message entries.
Exact quotes and the named pending turn take precedence. Long awaiting answers
retain the final question as well as their opening, including the smaller
recipient-classifier input. Speaker aliases,
timestamps and quote relationships are retained; the current input timestamp
(and event ID for equal-time source ordering) bounds visible context. No permanent
group summary is created. Old sources are fetched only through existing scoped
search. Context dependency checks are batched. Public provenance has one bounded 256-source
limit across Agent, result and delivery validation (ordinary searches keep 50).
Quotes and pending questions precede background; one slot is reserved for the new
question. If essential provenance itself fills the bound, an explicit call gets
a content-free request to reset and paste the key sentence in a new explicit call;
an unconfirmed implicit call stays silent. No tool or model runs on that overflow,
and no source dependencies are silently dropped to publish derived content. Implicit wakeup is not governed
by a fixed elapsed-time cutoff; timestamps are supplied for recipient judgment.
Reset closes that actor's implicit continuation and private drafts while keeping
public group content; explicit references can start a new turn. Reset ordering uses
the original event timestamp and event ID, so a delayed reset cannot clear a newer
actor generation or close a later public turn with the same timestamp.

Before image rollback, clear the allowlist **while the new image still runs**.
This fences all previously admitted v1 jobs, including explicit calls, at job
execution/result read and again before delivery. New explicit mentions use the
original path. Let the new worker cancel queued v1 jobs and their interactions;
verify there are no queued/running v1 jobs, queued/running associated interactions,
or pending/attempt-reserved associated deliveries. Wait for reserved sends to
finish or be classified unknown by the existing cleanup; never reset or resend
them. Only then restore the previous immutable image. If any row remains, keep
the new image and investigate; an old image does not understand `turn_request`.
A clean database migration alone is not this rollback acceptance.

## Measurement and acceptance

`interactions` records the event time, routing reason, terminal reply kind and
finish time without message text. Join its delivery's `search_result_id` to
`model_steps`, `model_calls` and `agent_tools` for Agent/model/tool counts.
Formal direct answers require both the answer reply kind and a delivered LINE
receipt; pickup notices, clarification, silent, unknown and failed outcomes are
reported separately. Compare predefined cases, not only successful answers;
uncompleted direct cases count as infinite latency in the p95 denominator.

Local evidence is recorded in `.artifacts/group-turns/`; the coordinator owns
same-condition old/new performance, hosted CI, merge, existing release workflow,
revision/config readback and rollback exercise. Two-account LINE/LIFF and Presenter
permission checks remain explicit device gates. Synthetic three-person tests do
not establish three-device acceptance. Enable no additional group before those
gates pass.

Protocol reference: LINE [quoted messages](https://developers.line.biz/en/docs/messaging-api/receiving-messages/#receive-quote-messages)
provide the referenced ID, not the original text. The app therefore uses only
its own currently authorized persisted source/confirmed-turn data.
