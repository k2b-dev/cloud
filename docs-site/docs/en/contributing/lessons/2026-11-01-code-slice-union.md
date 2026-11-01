### Combining slices can lose independent changes on the same declaration

- **What happened:** The combined Code branch lost imports and Action reviews, and two independently added documentation pages used the same navigation order.
- **Root cause:** Conflict resolution selected one side where the completed behavior required the union of both slices.
- **Error class:** Integration conflicts discard independent contract changes.
- **Guard:** Run every affected package typecheck, the capability presentation check and documentation validation on the combined branch. Use `git log --all -S` to recover each owning slice's change before resolving the conflict.
