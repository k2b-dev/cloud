### The v2 Mail list showed its error codes as text

- **What happened:** When the list of a mailbox could not load, the v2 pilot showed the server's code, such as `load_failed` or `invalid_search`, as the visible sentence. For a search that is not valid it offered "Try again", which cannot help.
- **Root cause:** `MailListV2` took `listError` as a `string` and printed it; the type let a stable code pass as human text. v1 mapped the codes to its catalog.
- **Error class:** A stable code typed as display text crosses into the interface unmapped.
- **Guard:** `MailListV2` takes `MailListError`, so the compiler refuses to print a code where a sentence belongs; the words come from the list catalog, and a search that is not valid offers "Clear search". `mail-v2.browser.test.ts` checks both states with the fixture state `?listError=`.
