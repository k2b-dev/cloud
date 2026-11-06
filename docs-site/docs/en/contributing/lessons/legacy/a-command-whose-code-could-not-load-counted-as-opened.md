### A Command whose code could not load counted as opened

- **What happened:** When the code for opening an app Command could not load, the Assistant removed the slash and kept the draft saved without it, although nothing opened.
- **Root cause:** `openCommand` resolved the same way after showing its reload notice as after opening.
- **Error class:** Nothing-opened outcome read as success.
- **Guard:** `openCommand` resolves `false` when nothing opened, tested in `commands.behavior.test.tsx`; `composer-app-commands.behavior.test.tsx` checks that the slash and the live draft stay.
