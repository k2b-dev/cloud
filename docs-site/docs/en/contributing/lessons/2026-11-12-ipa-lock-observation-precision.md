### Preserve database precision when ordering account lock observations

- **What happened:** A FreeIPA account sometimes remained unable to sign in after a completed unlock synchronization.
- **Root cause:** PostgreSQL stored lock times with microsecond precision, but the sync converted its later observation time to a JavaScript Date. Within the same millisecond, truncation made the later unlocked observation appear older than the lock. This also delayed out-of-scope transitions after unlocking.
- **Error class:** Loss of timestamp precision across a database boundary changes event ordering.
- **Guard:** `packages/cloud/src/services/ipa/account-lock.integration.test.ts` uses a private migrated database with a clock that advances one microsecond per observation, German date formatting, and the Europe/Berlin time zone. It verifies full-sync and sign-in unlocks, rejects locked accounts, keeps newer locks, and applies transitions after unlocking. Observation timestamps use ISO-8601 UTC independently of database formatting.
