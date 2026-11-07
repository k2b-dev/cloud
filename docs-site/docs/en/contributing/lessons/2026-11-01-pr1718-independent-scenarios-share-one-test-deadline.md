### Independent browser scenarios shared one test deadline

- **What happened:** Five dashboard publication-status scenarios ran inside one WebKit test and exhausted its combined deadline, although each scenario finished within its own budget.
- **Root cause:** Sequential fresh browser sessions shared one per-test timeout.
- **Error class:** Independent scenarios share one test deadline.
- **Guard:** Test: Pulse `Dashboard.browser.test.ts` checks each publication HTTP status in its own browser session with the existing 30-second dialog-test budget and keeps every original assertion.
