### Concurrent rules must preserve priority and the person's assignment decision

- **What happened:** Matching Mail workflows could overwrite each other's assignments, and a rule could assign a conversation again after someone removed its assignment.
- **Root cause:** Independent runs had no durable exclusive-effect order, and assignment actions used a frozen conversation snapshot without recording a workflow-specific undo decision.
- **Error class:** Concurrent effects bypass domain decision ordering.
- **Guard:** `workflow-effect-order.integration.test.ts` covers delayed and deferred upper rules, additive tags, terminal runs, expiration fences atomic claims, and preservation of intervening manual status decisions. `automation-log.integration.test.ts` covers current-assignment checks, undo across messages, redo, manual-change conflicts and conversation-scoped audit visibility, and recovery timestamps. `automation-log-recording.test.ts` prevents AI evidence from one conversation leaking into another conversation’s audit. `workflow-projected-state.test.ts` prevents skipped effects from restoring a state they never applied.
