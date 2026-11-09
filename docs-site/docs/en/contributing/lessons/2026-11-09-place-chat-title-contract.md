### Keep place snapshots within chat query contracts

- **What happened:** A valid place title longer than 120 characters made the new chat fail its read and search response validation.
- **Root cause:** Creation copied the provider's 200-character place title into the ordinary chat title, whose capability contract allows 120 characters.
- **Error class:** Contract drift between creation and downstream readers.
- **Guard:** The place creation route retains the full snapshot with a bounded chat title, and Core's integration test creates a maximum-length place title and validates both chat query results against their declared schemas.
