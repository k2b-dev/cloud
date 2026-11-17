### A stopped plan still looked like running work

- **What happened:** In the seventh Preview tour the plan above the field said "Aufgaben · 2 von 3" with its plum progress ring after the answer had broken off, so the header still looked like work in progress.
- **Root cause:** `Chat.Tasks` stopped the current step's ring while `paused`, but its header ring kept the AI colour, the same colour and shape as a running step.
- **Error class:** A pause that reaches one of two signs of the same state.
- **Guard:** While `paused`, the header's progress ring turns grey. `chat-tasks.browser.test.ts` checks that the paused ring no longer carries the AI accent.
