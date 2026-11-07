### Event discovery needs transport and query boundaries

- **What happened:** Event discovery documentation named unsupported CLI flags and described catalog failures as missing events. MCP read loaded every subscription, pagination accepted a cursor for a different publisher, and page sizing repeatedly serialized growing pages.
- **Root cause:** The discovery slice reused whole-catalog loading and generic errors without checking the CLI parser or the cost and validation of each transport path.
- **Error class:** Discovery contract drift and unbounded read amplification.
- **Guard:** `packages/cloud/src/api/mcp.test.ts` checks cursor/publisher consistency, detailed validation errors, escaped UTF-8 response budgets, event-specific subscription lookup, and unavailable/oversized reads. `packages/cloud/src/cli/events.test.ts` checks localized automation labels. Review convention: check documented global flags against the CLI parser.
