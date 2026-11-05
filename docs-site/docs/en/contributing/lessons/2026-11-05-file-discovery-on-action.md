### Discover file providers when a file action starts

- **What happened:** Pages with an attach or save control downloaded and validated the capability catalog even when nobody used files.
- **Root cause:** Importing the shared file runtime scheduled global provider discovery in an idle callback.
- **Error class:** Action-only work runs as a module side effect.
- **Guard:** `choose-files.browser.test.ts` loads the public file runtime, lets idle work run, and requires zero catalog requests. Its first file action loads providers, shows a recoverable failure, and retries in the same reserved frame. Existing geometry tests hold discovery pending on phone and desktop. The save browser test also keeps initial focus on the source when discovery finishes after opening.
