### The keys of an app read each creator's account on its own

- **What happened:** Admin › Apps › Keys named the person who created each key. For four creators the server sent 60 statements, about 15 for each person.
- **Root cause:** The page called `accounts.users.get` once for each creator inside `Promise.all`. That service reads a whole account, though the page needs only a name.
- **Error class:** A loader that calls a per-item service in a loop, where one bulk read gives what the page shows.
- **Guard:** `keyCreatorNames` reads every creator with `resolveDisplayNames` in one statement. `key-creators.integration.test.ts` pins one statement for twelve keys by four creators, and none for keys without a creator, with `sql-meter`.
