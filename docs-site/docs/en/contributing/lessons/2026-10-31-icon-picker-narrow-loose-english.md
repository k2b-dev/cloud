### The icon picker was as narrow as its field, searched one group loosely, and spoke English

- **What happened:** In the Notebooks settings, the icon picker opened only as wide as its 300px field, so the filter chips were cut off and two results fit. Typing "gro" showed "Alert" and "Adjustments", and every label, description, and group name was English in a German interface.
- **Root cause:** Every choice popover took the trigger's width. The search ran inside the default "Recommended" group and used a letter-by-letter subsequence match, so "gro" hit "warninG eRrOr" and "settinGs contROls". The bundled catalogue had no translations.
- **Error class:** A shared control sized, filtered, or labelled for its simplest consumer (a wide field, one group, English) breaks for the others.
- **Guard:** `packages/ui/src/inputs/icon-input.browser.test.ts` (popover width at least 26rem and inside the viewport beside a 300px field, chips not cut by the popover, "gro" finds only the matching icon across all groups, German labels under `de`, no movement while filtering) in Chromium and WebKit; `IconTexts` in `packages/ui/src/intl/messages.test.ts` keeps the German catalogue complete.
