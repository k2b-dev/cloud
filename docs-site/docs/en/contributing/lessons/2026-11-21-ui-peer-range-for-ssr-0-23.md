### The ui peer range missed another ssr minor

- **What happened:** The 0.83 release pull request bumps `@k2b/ssr` from 0.22.0 to 0.23.0 because #3813 added a `feat` under `packages/ssr`. The `@k2b/ui` peer range still ended at `^0.22.0`, so the release pull request's `dependencies` rule would fail.
- **Root cause:** #3813 did not follow the convention from the 0.64 lesson. release-please bumps pins but leaves peer ranges alone.
- **Error class:** A workspace version bump that a peer range in a sibling package does not accept.
- **Guard:** The existing `dependencies` rule rejects the release pull request before anything is published. The release lane now checks the peer ranges against the release pull request's versions before the freeze, which catches this case earlier. A stricter rule on `main` would also have to predict release-please's bump, so none was added.
