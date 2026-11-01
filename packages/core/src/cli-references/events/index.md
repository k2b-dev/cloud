# Events

Use `cld events ls` to read declared event types and subscribers. The table
shows the place type (`—` for service events) and automation (localized yes/no).
Use `--app <publisher-app>` and `--automation true|false` to filter declarations.
`--json` and `--jsonl` retain the full filtered `{ events: [...] }`
response, including schemas and subscribers.

Inspect `cld events subscriptions`, `cld events status`, and `cld events deliveries`
for blocked subscriptions, gaps, and failed delivery attempts. `status` includes
`rejectedCount` and the latest ten `rejections` with type, source, code, and receipt
time; no event payload is returned.

After reconciling subscribers affected by a retention gap, acknowledge it with
`cld events acknowledge-gap --yes`. This resets status to ready and records the
sequence range in the audit trail.

An administrator can retry one delivery with `cld events redeliver <id> --yes`.
The event ID stays the same, current declarations are checked again, and the
delivery receives a fresh 30-day retention window.

`deliveries` includes `heldBy` when an earlier unresolved delivery holds a
subscription and subject. Offline subscribers keep their backlogs without
spending handler attempts.

Record only synthetic fixtures with `cld events record <type> --shape-only --out fixtures.jsonl`.
`--limit N` samples the last N stored events and emits one fixture per distinct
version, present keys and bucketed array lengths, with deterministic unique IDs.
Test a local handler with `cld events replay fixtures.jsonl --handler ./handler.ts#handle`.
Replay reads the current catalog and calls the handler locally; it never sends fixture events to Cloud.
