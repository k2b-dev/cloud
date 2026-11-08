### An image save stays attached to its exact export until storage confirms it

- **What happened:** A generated image could reuse another export's receipt, and a missing receipt could release a save whose publication was still unknown. A browser storage failure before issuance could instead keep the editor waiting.
- **Root cause:** Export identity used metadata without bytes, and the adapter treated definite preflight failures and unresolved publication outcomes alike. In-place image saves also required a managed storage precondition.
- **Error class:** Incorrect upload reconciliation and unsafe replacement of changed content.
- **Guard:** Upload identity tests distinguish same-size exports and bound hashing memory; transfer guards retain unresolved keys. Files browser tests require copy-only unmanaged storage, reconciliation of the exact copy after a missing receipt, and zero requests with working draft dismissal after preflight failure. Existing revision, collision and cancellation guards remain in place.
