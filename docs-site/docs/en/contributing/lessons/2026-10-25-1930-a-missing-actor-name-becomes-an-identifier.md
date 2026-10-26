### A missing actor name becomes an identifier

- **What happened:** A deleted or unnamed actor appears as a UUID in CLI text.
- **Root cause:** A human history label falls back to a principal ID.
- **Error class:** A human history label falls back to a principal ID.
- **Guard:** Files `activity-transports.test.ts` checks English and German unknown-person labels through the CLI table projection; the `principal-id-labels` rule also rejects identifier fallbacks.
