### The period after a citation chip wrapped onto its own line

- **What happened:** In the P6 tour, Gustav's answer with sources ended a list item with "ab 17 Uhr [1]" and put the
  period alone at the start of the next line. In other items, a space stood between the word and the chip.
- **Root cause:** The citation chip is an inline block. Browsers allow a line break before and after an inline block
  even when no space separates it from the text. The model also writes a space before the citation, so the chip did
  not sit at its word.
- **Error class:** An inline block inside running text that has to stay attached to its neighbours: the layout breaks
  at the block's edges, and spaces that the source carries widen the gap.
- **Guard:** `rootResourceLinks` puts the word before a chip, the chip, and the closing punctuation after it in one
  `.ai-cite-run` that does not wrap, and drops the space before the chip and before that punctuation.
  `answer-sources.test.ts` checks the run for "Uhr[1].", "Uhr [1].", and "Uhr [1] ." and the `nowrap` rule in
  `effects.css`.
