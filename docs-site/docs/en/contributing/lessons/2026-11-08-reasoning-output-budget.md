### Reasoning exhausted the output budget without a visible explanation

- **What happened:** Assistant answers stopped midway or stayed empty while their turns appeared completed. Recorded output was 13,107 tokens, of which 13,106 were reasoning.
- **Root cause:** Neither Cloud nor Nessi 1.2.0 defines a fixed fractional output default. Without configuration or a usage-allowance cap, the request omits the limit. The source of the recorded 13,107-token limit could not be verified without production request or provider evidence. The persisted message already contained the terminal reason, but the shared renderer ignored it.
- **Error class:** Silent truncation.
- **Guard:** `output-budget.test.ts` checks reasoning budgets, reported limits, remaining context and explicit overrides. `stop-notice.test.ts` maps every typed terminal finish reason and unknown reasons to visible feedback, except normal completion and tool continuation. `stop-notice.render.test.tsx` checks persisted history in SSR; `live-turn.browser.test.ts` checks reloaded history and continuation on desktop and phone.
