### Reserve inference budgets only for inference

- **What happened:** Code Skill and other AI reads entered inference reservation and could be refused when the attempt allowance was zero or already reserved.
- **Root cause:** The bridge selected inference work by the entire `core.ai.*` namespace, which also contains non-model reads.
- **Error class:** Namespace membership is mistaken for an operation's resource consumption.
- **Guard:** `ai-budget.test.ts` excludes non-model reads from attempt reservation. `bridge.test.ts` compiles the shared Skill read fixture without infrastructure, catching missing input descriptions without integration infrastructure. The signed runner bridge regressions in `bridge.integration.test.ts` require Skill reads to succeed at zero and during an existing reservation, preserve that reservation, and require zero-budget generation to fail before dispatch with `code_ai_budget_limit`.
