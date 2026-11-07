### Provider diagnostics treated as metadata

- **What happened:** A provider error can contain input or output, including in its name, code, nested cause, or malformed tool-call fields.
- **Root cause:** Provider diagnostics were treated as safe metadata before consumers recorded them.
- **Error class:** Provider diagnostics treated as metadata
- **Guard:** Tests: Cloud `provider-errors.test.ts` and `provider-errors.integration.test.ts` send fictional canaries through structured calls, streams, and loops and check both AI ledgers, traces, logger storage, and console output. `executor.integration.test.ts` checks model-generated invalid arguments and unknown tool names. Normalize adapter errors before consumers record them, and normalize loop-generated diagnostics before logging.
