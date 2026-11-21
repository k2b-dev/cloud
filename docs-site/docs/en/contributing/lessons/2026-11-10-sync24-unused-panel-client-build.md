### Build only the client a browser fixture serves

- **What happened:** The Chat panel browser file exceeded its setup budget before running assertions.
- **Root cause:** The embedding fixture built its own client after also compiling the backend harness's unused standalone client. Diagnostics measured about 15 seconds in that unused build alone.
- **Error class:** Redundant fixture compilation consumes a bounded startup budget.
- **Guard:** The embedding fixture explicitly disables the standalone client build. Its existing Chat and Assistant browser cases still exercise the embedding bundle, with the same timeout and assertions. Build-stage diagnostics verify that the unused entry point is absent.
