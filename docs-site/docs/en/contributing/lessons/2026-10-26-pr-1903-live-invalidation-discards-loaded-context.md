### Live invalidation discards loaded context

- **What happened:** A revision replaces a multi-page directory with page one.
- **Root cause:** Live invalidation discards loaded context.
- **Error class:** Live invalidation discards loaded context
- **Guard:** Test: Chat system browser directory retains loaded rows and their DOM nodes after a message.
