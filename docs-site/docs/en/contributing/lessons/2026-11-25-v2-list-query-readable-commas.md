### v2 list addresses encoded their commas

- **What happened:** `serialize` of `@k2b/ui/v2/list-query` wrote list values as `level=warn%2Cerror` and times as `08%3A00Z`, while the approved concept shows readable addresses (`level=warn,error`).
- **Root cause:** `serialize` returned a plain `URLSearchParams`, whose text form encodes every character outside `*-._` and letters and digits, including `,` and `:`, which a URL query allows unencoded.
- **Error class:** Using a generic encoder's output as a public, human-read address format without checking it against the approved address examples.
- **Guard:** `packages/ui/src/v2/list-query.test.ts` pins the exact address text: readable `,` `:` `/` `@`, and an encoded value with a literal `%2C`, `&`, `=`, `+`, `#` that round-trips.
