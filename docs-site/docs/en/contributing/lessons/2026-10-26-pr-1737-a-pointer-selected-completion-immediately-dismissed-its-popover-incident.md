### A pointer-selected completion immediately dismissed its popover

- **What happened:** Selecting the table slash command in WebKit opened and immediately closed its size picker.
- **Root cause:** Completion ran on mousedown; the same press's release outside the new popover triggered native light dismissal.
- **Error class:** Opening a dismissible surface before its originating pointer gesture has finished.
- **Guard:** Notebook browser tests hold the pointer down, then release it and check the picker. Pointer-picked commands wait for release; keyboard commands retain their immediate scheduling.
