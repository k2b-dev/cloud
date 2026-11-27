### A green draft gate could authorize a ready PR before full CI finished

- **What happened:** After a draft PR became ready without a new commit, its light gate stayed green while the full gate waited for its dependencies. Required-check rules could accept that earlier success for the same head SHA.
- **Root cause:** Light and full validation published success under the same required check name, but changing PR readiness did not invalidate the draft check result.
- **Error class:** Reusing a required check's success across validation phases with different guarantees.
- **Guard:** The draft gate now fails deliberately while `check` reports light-check results. `scripts/checks/ci-gate.test.ts` executes the gate shell and requires a red draft gate even if every job succeeded; only a new full run can publish success.
