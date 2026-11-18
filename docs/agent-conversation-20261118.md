# LINE conversational Agent

Ray approved a ChatGPT-like conversational experience on 2026-11-18: natural answers and follow-ups, using group search only when needed. The same Agent may receive explicitly authorized OneDrive or YouTube tools later. This change adds no connectors, general plugin framework, services, queues, database migrations or CI/CD workflows.

- Keep the existing Agents SDK, provider/proxy path, budgets and scoped tool execution. General conversation can answer without tools. Group-specific claims use current evidence; writes remain reviewed proposals.
- Store bounded, encrypted conversation text in the existing requester/group checkpoint: at most six turns and 24 KiB, within the existing 30-minute idle lifetime. Revision changes, withdrawal, reset and authorization checks continue to invalidate derived context. Start a fresh context before accumulated source dependencies exhaust the evidence budget.
- Use existing durable jobs and interactions. Creating a job, associating its delivery and deferring its interaction commit together. Completed jobs reply directly; after at most 20 seconds (or five seconds before the token expires) only unfinished work offers a pickup action. Waiting does not occupy the interaction dispatcher, and background completion never sends a second Reply or Push.
- Show protected resource access as an action only when the answer has resources. Do not append raw LIFF URLs or internal actor IDs to every answer. Preserve existing LIFF authorization and Presenter collection ACLs.
- Discard failed database connections and handle checked-out client errors. Preserve both the original transaction error and rollback error. Fixed operation labels identify background failures without logging user content.

Acceptance covers real SDK/tool behavior, direct and deferred LINE delivery, long questions, follow-up/reset/isolation, source invalidation, bounded context, and database wire failures. A bounded four-turn synthetic provider check exercised the existing office proxy using synthetic evidence without sending LINE messages. Real user/device acceptance remains distinct from synthetic checks.

The retained plan’s five-second waiting target is superseded for this conversational correction: the real provider measured 2.6–6.8 seconds for the four synthetic turns. Waiting up to 20 seconds lets those answers arrive directly while reserving time before the one-use Reply token expires. The existing token deadline is unchanged.
