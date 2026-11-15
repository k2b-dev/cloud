### In-band reasoning appeared as answer text

- **What happened:** Kimi K3 responses through an OpenAI-compatible endpoint displayed internal reasoning and control markers in the answer.
- **Root cause:** The provider emitted reasoning inside content, with a closing marker and no opening marker. The previous nessi adapter classified that content as text.
- **Error class:** Provider control syntax crosses the transport boundary without normalization.
- **Guard:** `packages/cloud/src/ai/kimi-stream.test.ts` reconstructs the recorded marker span as single-character deltas and checks live and saved chat blocks against the installed nessi version. The nessi provider tests cover the full recorded message, every marker split, structured reasoning, and stream termination.
