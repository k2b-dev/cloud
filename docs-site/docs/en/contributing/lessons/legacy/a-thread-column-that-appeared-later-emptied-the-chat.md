### A thread column that appeared later emptied the chat

- **What happened:** In Chat, creating the first thread of a chat, or switching from a chat without threads to one with threads, left the message area blank until a reload.
- **Root cause:** `AppWorkspace.Main` renders its children without panes first; when a `MainPane` mounts later, the primary region reuses nodes from the discarded branch and stays empty ([#1752](https://github.com/k2b-dev/cloud/issues/1752)).
- **Error class:** Workspace layout changes shape after the first render.
- **Guard:** Chat keeps its thread pane mounted for every chat and shows it with CSS; a Chat browser test switches from a chat without threads to one with threads at 1440 and 2000 px. The library fix is pending in #1752.
