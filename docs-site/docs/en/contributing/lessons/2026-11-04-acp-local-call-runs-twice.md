### A local call runs twice when its result did not reach Cloud

- **What happened:** In `cld acp` and the interactive `cld assistant`, a local append, write, or Bash command whose result could not be posted to Cloud ran again with the next message, because the turn still waited for it. Appending `X` produced `XX`.
- **Root cause:** The set of executed client calls lived in the output of one prompt. The next prompt, or a resumed thread, followed the same waiting turn with a fresh set and ran the call again.
- **Error class:** A retry repeats an effect instead of its delivery.
- **Guard:** `packages/assistant/src/cli/acp.test.ts` "a local append whose result did not reach Cloud is sent again after resume, never run twice" fails the first delivery against the fake Cloud, resumes the thread, and checks that the file holds `X` and that the same result is posted again. `stream.test.ts` checks that an older snapshot of a finished turn in another stream does not run the call again and that receipts stay bounded without dropping a result still to deliver. `ClientCallReceipts` in `stream.ts` keeps each call's state by chat, turn, and call ID.
