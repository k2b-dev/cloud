### A page pattern names a path on this Cloud

- **What happened:** The `code.pages` pattern check accepted any value that began with `/` and contained `{id}`, including a value beginning with `//`.
- **Root cause:** The pattern only required a leading slash. A browser reads a leading `//` as the start of another host, not as a path.
- **Error class:** A path check that does not rule out a protocol-relative value.
- **Guard:** The definition check and the registry manifest schema both require a leading slash that is not followed by a second one. `code-access.test.ts` covers both with protocol-relative values.
