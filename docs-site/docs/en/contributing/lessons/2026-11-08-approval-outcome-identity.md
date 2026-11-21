### Keep an answered approval mounted when its live request disappears

- **What happened:** A chat approval lost its head and replaced its focused outcome node when the server acknowledged the answer.
- **Root cause:** The chat identified approvals only by the live `approval` object or waiting status, ignoring the stored approval decision.
- **Error class:** Dropping a component's identity across an async state transition.
- **Guard:** `packages/cloud/src/ai/chat/approval.behavior.test.tsx` requires the same outcome node before and after server acknowledgement for approval and rejection.
