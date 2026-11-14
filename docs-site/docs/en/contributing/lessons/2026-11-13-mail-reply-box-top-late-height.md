### The reply box on top grew after it loaded and pushed the messages down

- **What happened:** With the reply box above the conversation (since #3288), a slow load moved the messages: the loading box was 200 px high, the loaded box 303 px in Chromium and 63 px taller in a WebKit gate run (#3297). The draft, its signature (a request of its own) and a suggestion all arrive after the first paint.
- **Root cause:** The loading box reserved a fixed minimum, while the loaded box took the height of content that only the loaded draft knows. Under the conversation this never showed, because nothing sits below the box; on top every late row moves the messages.
- **Error class:** A loading state reserves less room than late content takes, above content the person reads.
- **Guard:** On top, the loading box and the loaded box share one reserved height; text and signature fade out at that height, and the box grows only when the person clicks, focuses or drags a file into it. `mail-shell.browser-suite.ts` holds the draft answer and the signature back so every runner meets the loading box, and asserts that the messages do not move.
