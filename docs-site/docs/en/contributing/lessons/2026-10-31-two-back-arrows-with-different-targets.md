### Version history and the note graph showed two back arrows with different targets

- **What happened:** On a phone, a note's version history and the Links graph showed the shell's back arrow to the notebook next to their own back control to the note. Two arrows led to two places. Valentin asked on 2026-10-31 to drop top back links that are not the only way back.
- **Root cause:** The notebook page gave the shell the same title array in every mode, with the notebook as a level above the note, also when the mode draws its own way back.
- **Error class:** Shell chrome adds a way up beside a view's own back control, and the two disagree about where back is.
- **Guard:** In `versions` and `graph` mode the notebook entry has no `href`, so the shell adds no way up; `page.render.test.tsx` checks both modes and that a plain note keeps its way up to the notebook.
