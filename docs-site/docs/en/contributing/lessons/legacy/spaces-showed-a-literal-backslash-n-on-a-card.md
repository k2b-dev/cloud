### Spaces showed a literal backslash-n on a card

- **What happened:** A Kanban card preview showed `Caption:\nText` instead of a line break ([#1178](https://github.com/k2b-dev/cloud/issues/1178)).
- **Root cause:** The stored description held a backslash and an `n`. A shell keeps `\n` inside quotes as two characters, and a model can double-escape JSON; the Spaces CLI and capability inputs stored that text unchanged. The preview only showed what was stored.
- **Error class:** Escaped text input.
- **Guard:** Tests in Spaces: inline CLI text and capability text inputs reject `\n` outside inline code when the text has no real line break. Stored text and the browser editor stay unchanged, because `\n` can be real content, such as a Windows path.
