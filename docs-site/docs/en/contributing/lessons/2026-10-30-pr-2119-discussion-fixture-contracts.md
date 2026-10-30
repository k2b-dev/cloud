### Migrate discussion fixtures at every consumer seam

- **What happened:** Chat's generic discussion migration passed focused provider tests but failed mention, notification, attachment, live, search, and browser tests in CI.
- **Root cause:** Several suites still supplied domain-specific reader payloads without a discussion catalog or standard `view`. UI assertions retained the former section label and fixed provider icons. The search budget assertion treated partial results as provider failure.
- **Error class:** Consumer test fixtures drift after a shared contract migration.
- **Guard:** Run each affected consumer file separately. The migrated suites use third-party providers with opaque IDs and standard reader views while retaining denial and revocation assertions. Avatar and provider integration tests verify catalog type icons, fallback icons, and independence from stored chat icons. Search asserts that discovery and remote readers share the call budget and exhaustion returns `incomplete`.
