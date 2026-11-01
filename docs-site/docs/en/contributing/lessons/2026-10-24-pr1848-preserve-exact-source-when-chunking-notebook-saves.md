### Preserve exact source when chunking Notebook saves

- **What happened:** Saved map Markdown can exceed both the 200,000-character
  create limit and the 256 KiB request limit after JSON escaping.
- **Root cause:** Splitting content through ordinary append inserts paragraph
  separators, which can corrupt JSON strings inside a document.
- **Error class:** Chunking a structured document changes its source.
- **Guard:** `note-edit.test.ts` covers exact append and unchanged defaults;
  `map-notebook-save.test.ts` covers serialized byte limits, surrogate
  boundaries, hash reconciliation, cancellation, and unknown creates. Chunked
  saves use explicit `separator: "none"` and full-source hash preconditions.
