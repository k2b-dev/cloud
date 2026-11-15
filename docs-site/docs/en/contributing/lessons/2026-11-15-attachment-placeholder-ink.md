### An image attachment without its preview showed its sign in full ink

- **What happened:** In the Gustav chat, an image the person attached whose preview could not load showed a black image sign in light mode and a white one in dark mode, louder than the message itself (design review of #3388).
- **Root cause:** The rule that sizes the fallback sign for the 148 × 110 px preview set only its size, so the sign inherited the tile's full text colour.
- **Error class:** A placeholder that stands in for missing content inherits full ink instead of a quiet colour.
- **Guard:** The chat gallery browser test compares the fallback sign's colour with `--k2b-text-subtle`.
