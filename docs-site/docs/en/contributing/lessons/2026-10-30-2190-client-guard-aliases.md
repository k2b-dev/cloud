### Client migration checks must follow aliases and bound test exemptions

- **What happened:** The migration check missed native clients accessed through module aliases, computed destructuring keys, or constructor values. Production files under directories named `fixtures` or `tests` also escaped the pool and connection checks.
- **Root cause:** The check recognized direct expressions and `new` calls but did not track module assignments or constructor references. Fixture detection matched directory names at any depth.
- **Error class:** Incomplete syntactic regression checks and overly broad path exemptions.
- **Guard:** `scripts/checks/platform-clients.test.ts` covers module assignments, literal keys, constructor aliases and reflection, type-only uses, and exact test roots. The check keeps source-content baseline matching while restricting fixture exemptions to known roots and listed files.
