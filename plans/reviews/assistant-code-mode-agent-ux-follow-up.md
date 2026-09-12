# Code Mode agent UX review follow-up

Implemented against `assistant-code-mode-agent-ux-review.md`, September 12, 2026.

## Changes

- File downloads and test picker fixtures pause startup and agent readiness
  watchdogs. The existing 45-second outer tool deadline still bounds transfers;
  capability approval waits retain their existing exemption. Native picker waits
  also pause startup in user runs.
- At capacity, the host reclaims finished disposable one-offs. Saved resources,
  UI, captured exports, queued requests, pending input/approval/modal, and active
  jobs remain protected. Explicit stop is available for retained runs.
- Tool argument validation returns `kind: "input"` before running source.
  Snapshot output now declares truncation through `outputTruncated`.
- Skill version 19 narrows triggering and moves the first file script into its
  entry page. It explains converted document reads, explicit app test fixtures,
  exports as later inputs, incremental investigation, and outcome verification.
  GUI references remain optional for headless work. Kit triggering now targets
  existing Kit resources (template version 3).
- References align deadline explanations, document bundle stack positions,
  expose list search, and explain repeatable imports with stable keys.

## Verification

Focused Chromium tests exercise slow input download beyond both short startup
limits, native script file selection after a 16-second wait, eviction pressure
with retained downloads/UI/background jobs, malformed arguments, and truncated
output. Existing host tests cover approvals beyond 45 seconds, denial, capability
results, input isolation, cancellation, and database error transport. Skill
examples and generated seed consistency are checked separately, with the
Assistant TypeScript check and whitespace review.

F7 is verified for a user-mode script using the same native picker as the app
panel. F10 is handled explicitly at the frontend tool boundary, independent of
upstream model argument validation. Compiled stack traces remain bundle-relative;
this slice documents that behavior rather than adding source maps.

No live model behavior evaluation or deployed service restart is included. Tests
use the current checkout in isolated browser hosts; they do not establish that
an existing chat has loaded the new skill. Downloads exceeding the outer tool
budget remain bounded failures. Completed runs retaining exports are deliberately
not evicted automatically.

Final checks: skill/seed tests passed (8 tests, 383 assertions); the real worker
browser test passed (54 assertions); slow input plus scratchpad pressure passed
(2 tests, 41 assertions). The raw Assistant TypeScript check and `git diff
--check` passed. Harper findings were reviewed; technical names and existing
heading style were retained.

The full CLI host test file is not consistently green: database transport timed
out once, and the pressure test timed out twice in full-file runs. Both pass
isolated, and the new pair passes together. Other existing host cases passed,
including a 46-second capability approval. The cause of these order-dependent
or intermittent failures is not established; a separate investigation is tracked.
No timeouts were increased to conceal these failures.
