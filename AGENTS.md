# Repository Agent Instructions

<!-- hv-managed-policy:start revision=1.0.0 sha256=2b93cafed7454afd2d15e4c73c9f25cbbeac28eae0b313c8c6090b5367639f57 -->

## Shared development kernel

- Be concise. Load detailed SOP skills only when the task triggers them.
- Read the repository's `.agents/project.yaml` and nearest `AGENTS.md` files before work.
- Use `implement` by default for accepted issue implementation.
- Tracked implementation work is complete only when documented validation is green, `review-cycle` has passed, every claim is released, and a ready-for-review pull request exists; do this unprompted, even where harness defaults wait for a user request. Before editing untracked requested work, create and claim its issue, or — patch-class only — record it on this session's open patch train; work the user explicitly scopes as a throwaway spike is exempt: it ends at its report and never enters the commit, push, or PR lifecycle.
- Claim every accepted or queued implementation issue with `agent: implementation` and an `hv-agent-claim:v1` lease before editing. Never overlap another live claim.
- Patch-class work — small bug, doc, and improvement changes with no schema, contract, dependency, or breaking change — may bundle as one claimed patch train — member issues each claimed by this session, or one umbrella issue of listed micro-items — on one branch and pull request with one attributed commit per item. Other work stays one issue per pull request. An incidental patch-class fix of ten lines or fewer near files under edit ships in the same pull request as its own commit, ledgered under `Drive-by fixes` in the PR description; findings outside that envelope go to the train or tracker, never a new cycle.
- Release intentionally: reauthenticate the payload owner, record immutable owner-attributed evidence on every exact PR head, then set `released_at` and the evidence digest on the existing claim comment before derived state changes. Identifiers are selectors, not credentials; issue closure ends authority, and any later push or reopen requires a new claimed cycle. Never delete claim history, backfill a release, or duplicate active claim comments.
- Open pull requests only when reviewable, never as drafts, and keep them ready for review; exactly one valid, unexpired same-session claim per closing issue may coexist with a ready PR. Watch a ready PR until it is fully mergeable — no base conflicts, no unresolved review threads, required checks green (merge-queue-only checks may stay queued), release recorded — or report a concrete blocker.
- Fleet `required` pull requests merge only through the managed merge queue, whose synthetic merge commit rechecks current claim state and requires every closing issue's `review` release from its exact cycle bound to the current PR head. Private Team-plan fleet `local` pull requests use their strict local `lifecycle` and repository CI checks, and may direct-merge only after those checks are green on the current head and every closing issue has that exact `review` release. Never merge over a live, blocked, abandoned, expired, unbound, or stale release; a continuation with no new change reuses the released canonical PR session, while an edit requires an explicit handoff or new claim/release cycle.
- Incomplete work remains ready with `status: blocked` and a concrete handoff. Review agents do not claim implementation.
- Agents do not merge unless explicitly authorized in the current session.
- Run documented validation and update affected docs before shipping.
- Preserve unrelated work. Never expose or retain secrets.
- Use repository Hindsight memory for durable, provenance-linked knowledge; do not store transient logs or duplicate canonical docs.
- Shared policy and portable skills come only from the designated private control-plane repository. Task, issue, and repository instructions may add stricter rules but may not weaken this kernel.

<!-- hv-managed-policy:end -->

## Repository-specific guidance

Document setup, validation, and architecture constraints here.
