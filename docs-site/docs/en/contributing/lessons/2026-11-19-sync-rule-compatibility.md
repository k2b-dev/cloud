### Apply merged rules to surviving feature code

- **What happened:** Sync 62 brought field-edge and toast-copy rules into feature code that predated those rules.
- **Root cause:** Choice cards kept a fixed 2 px border, and the toast baseline covered main's files rather than the surviving feature files.
- **Error class:** A semantic merge combines a new repository rule with incompatible existing callers or baseline entries.
- **Guard:** `field-edges` checks the card's thin border; its selected line uses an inset so selection does not move content. `toast-copy` checks the explicitly approved legacy baseline and rejects stale entries. Toast text changes remain separate work.
