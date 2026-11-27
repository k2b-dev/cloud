### Give each v2 part with its own behaviour a module of its own

- **What happened:** A Chat page loads later, and a v2 `Select` on it still added 47 KB to the first chunk of every Chat page. Chat used a `Menu` with a tick in its place.
- **Root cause:** Bun splits code by module. A module that the first chunk loads carries every statement any chunk uses, together with each module that this code reaches. `Select` stood in `controls.tsx` beside `Input`, so its listbox behaviour came with every form. `TagsInput`, `CodeInput`, `ImageInput`, `Slider`, `ColorInput` and `DateInput` did the same. `Prose` in `content.tsx` brought Markdown with every `List`. `Group` and `Disclosure` in `structure.tsx` brought the file picker with every `Section`. The barrel `index.ts` did not leak.
- **Error class:** A part with behaviour of its own shares a module with a part that nearly every page loads at once.
- **Guard:** `packages/ui/src/v2/lazy-chunks.bundle.test.ts` builds a page from the common parts. Every other export goes in a lazy chunk of its own. The test fails when a lazy part brings a module into the first chunk.
