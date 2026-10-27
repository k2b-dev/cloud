### Detail rows showed their commands outside the row they belonged to

- **What happened:** In the Mail details panel the "Save to Files" button of an attachment sat beside the row's hover fill and stayed hidden on a desktop, while "Download" was always visible as `trailing` text. The same file attached to three messages appeared three times.
- **Root cause:** `DetailPanel.Action` painted its hover fill on the main action's label only, so a `secondaryAction` or menu in the same row was outside the surface it revealed with. Mail put a command into `trailing`, which is meant for quiet facts, and listed every message's attachments with `flatMap` without merging equal content.
- **Error class:** A row command placed outside the row's interaction surface, or a list that repeats one file for every place it occurs.
- **Guard:** `packages/ui/src/content/file-list.browser.test.ts` checks that a row with a secondary action fills as one surface past its buttons, that `FileGrid` row actions show on hover, focus, and touch without moving any box, and the "Show all N" folding. The DetailPanel page documents that `trailing` holds facts, not commands.
