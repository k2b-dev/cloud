### A minor ssr release needs a wider ui peer range

- **What happened:** The 0.64 release pull request bumped `@k2b/ssr` from 0.20.2 to 0.21.0 because #2535 added a `feat` under `packages/ssr`. Its `check` job failed: the `@k2b/ui` peer range for `@k2b/ssr` still ended at `^0.20.0`.
- **Root cause:** release-please bumps pinned versions but leaves peer ranges alone. The feature pull request did not widen the range, so the gap appeared only on the release pull request, after the freeze.
- **Error class:** A workspace version bump that a peer range in a sibling package does not accept.
- **Guard:** The `dependencies` rule in `scripts/checks` fails when a peer range on a workspace package rejects that package's version. Convention: a `feat` or `feat!` pull request that changes `packages/ssr` also adds the next `@k2b/ssr` minor to the `@k2b/ui` peer range.
