### Removing markup joined words in note metadata

- **What happened:** Titles and excerpts joined words separated by break or paragraph tags.
- **Root cause:** Plaintext extraction replaced tags with an empty string.
- **Error class:** Removing a separator changes the meaning of the surrounding text.
- **Guard:** Tags become spaces before whitespace is normalized. A focused metadata test checks the resulting word boundaries in titles and excerpts.
