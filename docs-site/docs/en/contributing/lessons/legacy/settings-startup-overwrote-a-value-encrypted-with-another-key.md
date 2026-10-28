### Settings startup overwrote a value encrypted with another key

- **What happened:** Starting an application with a different `APP_SECRET` replaced a saved setting with its environment value ([#1295](https://github.com/k2b-dev/cloud/issues/1295)).
- **Root cause:** Normalization skipped the unreadable row, then bootstrap treated its key as missing and upserted the environment value.
- **Error class:** Unreadable treated as missing.
- **Guard:** `bootstrap.integration.test.ts` checks that unreadable and invalid rows keep their ciphertext and fixed timestamp. Bootstrap only inserts missing rows; normalization updates only the ciphertext it read.
