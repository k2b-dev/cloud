### The AI library did not enforce its own provider and tool contracts

- **What happened:** `@k2b/nessi` 0.18.0 followed HTTP redirects with custom provider credential headers, ran tools with their input defaults when a model sent arguments that were not a JSON object, and passed tool results on without the output schema's parsing. Cloud pins nessi exactly, so every AI call carried these gaps (GHSA-x5w4-vqg5-v2mc, GHSA-r7mg-9j2m-2h92).
- **Root cause:** nessi used the default `fetch` redirect mode for authenticated requests, converted unparseable tool arguments to `{}`, and discarded the result of the output schema's `safeParse`.
- **Error class:** A shared library validates an untrusted value or a security-relevant default, but lets the unvalidated value continue downstream.
- **Guard:** nessi 0.19.0 adds regression tests that fail on 0.18.0: `tests/ai/providers/redirects.test.ts` uses two loopback origins and a positive control, and `tests/tool-contracts.test.ts` runs a provider, completion, stream, and loop matrix over malformed arguments and output schemas. Cloud takes the fix through the exact pin in this bump.
