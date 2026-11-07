### Password reset tests failed while other test files ran on the same host

- **What happened:** The reset link tests in `me-password-sign-out.integration.test.ts` answered 500 with "FreeIPA is enabled but not fully configured. Missing: freeipa.service_password." in some local runs, on main and on branches alike.
- **Root cause:** Every integration test process on a host shares one Valkey keyspace, but many processes use their own database. A process whose database has no `freeipa.service_password` row cached its "missing" marker under the shared `settings:` key, and this file then read the empty default for up to five minutes.
- **Error class:** An integration test trusts the shared settings cache for values that another process with a different database can replace.
- **Guard:** The file stubs `getFreeIpaConfig` with a configured fixture; a concurrent reader with its own database no longer changes the result.
