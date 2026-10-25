### Give independent PIN-change outcomes their own test cases

- **What happened:** The PIN-change correctness test exceeded its existing five-second deadline without reporting a failed correctness assertion.
- **Root cause:** Initial PIN setup, changing the PIN, rejecting the old PIN, and unlocking with the new PIN performed four real Argon2 derivations inside one case.
- **Error class:** Expensive fixture preparation and independent outcomes share one test deadline.
- **Guard:** A prepared real fixture feeds separate old-PIN rejection and key-preservation cases. The fixture and both cases keep the default deadline; all cryptographic parameters and assertions remain unchanged, and created sessions are locked during cleanup.
