### Spaces and Notebooks built style strings from stored colours

- **What happened:** Spaces (space, status, wormhole and bucket colours) and Notebooks (comment and presence colours) put a stored colour into a style string as it was. Their contracts store only hex colours, so nothing showed. A value with a `;` would still have added declarations to that string.
- **Root cause:** The pages relied on the check at write time. A string style takes whatever it gets.
- **Error class:** A value from data goes into a style without a check where the style is written.
- **Guard:** Each app has a `hexColor` in `src/frontend/lib/color.ts` that passes only `#rgb` or `#rrggbb`, its own contract. Every style string with a stored colour goes through it and falls back to the default colour. `packages/spaces/src/frontend/[id]/_components/list/ItemRow.render.test.tsx` and `packages/notebooks/src/frontend/[id]/_components/editor/note-preview.test.ts` render such a colour with a `;` and expect no declaration of its own.
