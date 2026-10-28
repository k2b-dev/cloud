### An automatic send treats generated content as an authored template

- **What happened:** Workflow-generated values, including persisted conversation summaries, reach an automatic reply without a person reviewing the exact message; publication-only validation leaves old versions and retries active.
- **Root cause:** Publication-only validation left stored definitions and queued retries outside the send policy.
- **Error class:** An automatic send treats generated content as an authored template
- **Guard:** Tests: Mail `workflows/workflows.test.ts` rejects AI and summary-dependent send definitions. `service/workflow-kernel.integration.test.ts` runs legacy definitions and queued retries through real send policy, verifies no SMTP call, and keeps non-AI templates working. Enforce the stored-version policy when queuing and immediately before the provider effect.
