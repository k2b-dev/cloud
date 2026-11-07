### Contacts could lose its last manager or accept a stale manager's change

- **What happened:** A book-bound API key counted as a manager, and a person lowered while waiting could still change another grant ([#1233](https://github.com/k2b-dev/cloud/issues/1233)).
- **Root cause:** Contacts counted every admin grant and authorized before locking its ACL rows.
- **Error class:** Manager invariant; ordering and concurrency.
- **Guard:** `access-last-manager.integration.test.ts` exercises the HTTP routes, localized `LAST_MANAGER` errors, concurrent self-demotions, stale authorization, agent managers, administration recovery, and outbox writes. Contacts locks the book before reading grants and rechecking the actor in the same transaction.
