### A question takes one answer while the first still runs

- **What happened:** `Chat.Decision` took a second press of an answer while the promise of the first one still ran, so a host that kept the question open received the same answer twice. A `more` answer had no guard at all.
- **Root cause:** `answer()` released its guard in a microtask after calling `onSelect`, before a returned promise settled; `more` answers called `onSelect` directly.
- **Error class:** A guard against repeated actions was released when the call returned instead of when its asynchronous work settled.
- **Guard:** `chat-decision-answers.behavior.test.tsx` holds every answer while one promise is pending and gives them back after resolve and reject; the Chromium test in `chat-decision.browser.test.ts` repeats Enter, Space and a double click on a pending answer and checks that one answer is sent, focus stays and nothing moves.
