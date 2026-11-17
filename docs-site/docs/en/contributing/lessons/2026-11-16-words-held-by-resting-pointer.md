### A resting pointer held the thinking words

- **What happened:** In the seventh Preview tour at 390 px, Gustav's work line said "Denkt nach" for 12 seconds after sending; the words changed only once the mouse moved elsewhere.
- **Root cause:** At 390 px the start page's field stands where the work line appears after sending. The pointer that pressed send rested there, the line appeared under it, and `Chat.Activity.Words` took the pointer's arrival as a hover that holds the word.
- **Error class:** Treating a pointer that content moved under as a person pointing at it.
- **Guard:** The word holds only once a pointer that is not a finger moves on the row, or while the focus is in it. `chat-activity-words.browser.test.ts` renders the row under a resting pointer and after a tap at 390 px and expects the words to change.
