### Optional peers of stdlib declared no version

- **What happened:** `@k2b/stdlib` declared its optional peers `solid-js` and `lean-qr` with an empty range since its first release, so npm and Bun accepted any version, including major versions the SolidJS helpers and the QR subpath were never built for. The 0.85 release check (`packed`) also found that the move into `packages/stdlib` (#4014) changed the packed package without a version bump.
- **Root cause:** An empty string is a valid range in `package.json` and means "any version". Nothing checked optional peers for a real compatibility range.
- **Error class:** A published peer dependency with an empty or catch-all range.
- **Guard:** The two peers now name the major they support (`solid-js` `^1.9.0`, `lean-qr` `^2.7.0`). This release of stdlib also puts the package moved by #4014 on npm. No new rule: the remaining optional peers already carry ranges, and the `packed` release check catches an unreleased change to a pinned sibling.
