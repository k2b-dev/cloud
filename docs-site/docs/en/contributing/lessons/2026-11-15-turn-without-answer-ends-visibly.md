### A turn ended after its steps without any answer and the chat stayed silent

- **What happened:** In the Preview, Gustav (kimi-k3) built an automation; after a step the model answered with an empty message and a normal stop. The chat showed the work line and nothing else: no answer, no error, no way to go on (finding 85).
- **Root cause:** A turn whose loop ends with `stop` counts as completed. The chat only explained turns that failed, were stopped, or were cut off; a completed turn without text, result or action had no ending of its own.
- **Error class:** A normal-looking ending that leaves nothing to read or act on ends in silence.
- **Guard:** The chat's presentation gives such a turn the notice "The answer ended without any text" with Continue and Answer again (`no_answer` in `stop-notice.ts`). `timeline.behavior.test.tsx` replays the empty final message and expects the notice and Continue; it fails without the guard.
