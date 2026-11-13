### Saved requires retained bytes covering the visible input

- **What happened:** A cursorless transport echo followed by an unrelated peer update could make collaborative Mail input appear saved before the broker retained it.
- **Root cause:** Durability was inferred from the complete live document after the provider drained its transport queue. The live document can include bytes with no broker receipt. Mail now accumulates only cursor-bearing server updates or persisted snapshots and checks causal coverage of the visible state.
- **Error class:** Confusing transport convergence with durable coverage.
- **Guard:** `packages/mail/src/frontend/_components/mail-draft-session.behavior.test.tsx`, “shared transport echoes and offline input never claim durable server storage”, holds the covering acknowledgement through a cursorless echo and a retained peer delta. `mail-draft-document.browser.test.ts` repeats the covering-receipt boundary in Chromium and WebKit at desktop and phone widths.
