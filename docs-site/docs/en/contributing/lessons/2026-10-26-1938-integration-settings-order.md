### Integration shards exposed a shared issuer left by earlier tests

- **What happened:** OAuth discovery returned an unexpected origin, and consent decisions redirected without an authorization code in two integration shards.
- **Root cause:** Two integration files stored their temporary server URLs in `app.url` without restoring them. OAuth files assumed a fixed issuer instead of declaring it; the unsharded order happened to replace the leaked setting before those files ran.
- **Error class:** Shared integration configuration leaks across files and makes results depend on execution order.
- **Guard:** OAuth consumers declare their issuer with `useTestSettings`; the two producer suites preserve every setting they change. The settings fixture regression tests start with a conflicting issuer and verify setup and restoration across Postgres, Valkey and the identity configuration cache, including false values and originally absent rows. The testing guide requires each file to declare its settings and restore shared changes.
