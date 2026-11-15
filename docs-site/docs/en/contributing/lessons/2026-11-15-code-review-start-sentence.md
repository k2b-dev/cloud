### Distinguish a review decision from the start of its revision

- **What happened:** A changes request appeared twice in chat, once as a decision and again at the start of the automatic revision.
- **Root cause:** Delivery was idempotent, but the stored review-start message repeated the decision sentence, which the event renderer had already shown.
- **Error class:** Two distinct lifecycle events described the same outcome.
- **Guard:** The admission integration test retries the worker, checks exactly one decision and one start, and verifies the stored start sentence describes only the revision beginning, without reviewer text or names.
