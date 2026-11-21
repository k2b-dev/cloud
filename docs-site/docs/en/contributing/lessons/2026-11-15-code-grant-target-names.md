### Resolve grant target names at the outer request boundary

- **What happened:** A mailbox-owned Code displayed its readable mailbox name but only the Space type under its permissions.
- **Root cause:** Owner authorization consumed Core's one child Query; the target-name resolver correctly left subsequent resources unavailable. A catalog lookup with viewer authority could not restore the already-spent reader budget.
- **Error class:** Presentation composed several permission-aware readers inside a single-use invocation budget.
- **Guard:** Core projection tests preserve exact static lookup references while denying names for unresolved, explicitly hidden and dynamic targets. The shared grant-name composition tests use independent canonical readers, permit only their authorized titles and open links, keep denial/failure fallbacks, deduplicate targets and preserve the 50-row bound. Consumers compose at the outer request boundary; no nested invocation allowance changes.
