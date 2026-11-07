### The storage settings test reported a save although nothing was saved

- **What happened:** The storage connection test printed `{"saved":true}`, so an operator could not see that a test ran and passed (#2364). The PDF and FreeIPA tests and `ai enrichment run` printed the same.
- **Root cause:** All non-GET entries in the administration operation table share one success output for configuration changes, whatever the operation does.
- **Error class:** A shared command path prints the result of its most common case for operations that do something else.
- **Guard:** `administration.test.ts` finds every `test-` and `run-` route in the table and requires it to declare a `report`, and it checks the output of each one and that a failed check fails.
