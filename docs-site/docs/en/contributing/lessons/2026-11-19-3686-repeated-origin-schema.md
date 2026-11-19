### Share origin definitions within capability schemas

- **What happened:** Combining alarm origins with the updated Core contracts exceeded the capability manifest's existing 400 KiB limit.
- **Root cause:** Chat reads and searches each embedded the same origin union in both history messages and send receipts.
- **Error class:** Repeated JSON Schema expansion exceeds a bounded registry manifest after a merge.
- **Guard:** Give the shared origin schema a stable local definition so each operation references it without changing validation. The origin round-trip test covers all variants and malformed alarms; `capability-presentation` still compiles the complete manifest against the unchanged byte limit.
