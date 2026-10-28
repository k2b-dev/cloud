### Replay deduplication assumes contiguous revisions

- **What happened:** Renewing from the batch tail skips filtered events; deduplicating against the live watermark drops unseen earlier events.
- **Root cause:** Replay deduplication assumes contiguous revisions.
- **Error class:** Replay deduplication assumes contiguous revisions
- **Guard:** Tests: Chat store batched discovery resumes at the first relevant hint and fills replay gaps exactly once.
