### Keep map history links inside the active Assistant host

- **What happened:** Opening an older map from the Assistant panel could navigate to the full application.
- **Root cause:** The follow-up link hardcoded the full application path instead of retaining the current host path when fetching the history anchor.
- **Error class:** A shared surface loses its navigation context.
- **Guard:** Map widget browser cases cover host-relative history links in full Assistant and its panel at desktop and phone widths.
