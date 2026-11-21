### Classify Code operations by effect

- **What happened:** Reading chat history counted as AI use in checked Code.
- **Root cause:** The classifier matched every operation under `core.ai` instead of the operations that perform inference.
- **Error class:** Namespace-based effect classification.
- **Guard:** `core/src/code/policy.test.ts` enumerates inference and read operations; SDK policy tests use the same shared classifier.
