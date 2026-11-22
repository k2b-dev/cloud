Closes #3702

## What changes for Cloud users

A message sent right after Quote (type, Enter) now always carries the quote. Before, it could go out without the quote, and the quote then showed up in the emptied composer, next to the next quote.

## Root cause

`ChatConversation` moves the focus into the field as soon as Quote is pressed, but `ChatWorkspace` added the quote only after `importOnDemand(() => import("./chat-quote-selection"))` resolved, even when the module was already loaded. A send in between read an empty quote list and cleared it; the quote landed afterwards. That is exactly the CI failure in "quotes in the dark theme" (sent quote from Lea Muster still in the composer next to Ben Schulz's).

Fix (`ChatWorkspace.island.tsx`): quotes on their way are chained in one promise, and `send` waits for it before it reads the draft's quotes. No timing, budget or test change for the old test.

## Guard

New browser test in `ChatQuotes.browser.test.ts`: "a send right after Quote carries the quote while its code still loads, and leaves the field without it". It holds the `chat-quote-selection` chunk via `page.route`, quotes from the message menu, types and sends, and only then releases the chunk. It checks that the posted message carries the quote and that the composer shows no quote. Red without the fix (posted message without `quotes`), green with it. Lesson: `docs-site/docs/en/contributing/lessons/2026-11-22-chat-quote-lands-after-send-3702.md`.

## Changed paths

- Quote via the selection pill or the message menu, then send: unchanged result, now also when the send comes before the quote landed.

## What ran locally

- `bun test packages/chat/src/frontend/ChatQuotes.browser.test.ts` (Chromium): 8/8 pass with the fix; the new test fails without it.
- `bun run --cwd packages/chat typecheck`: pass.
- `scripts/check.ts` all 96 rules without typecheck: pass.
- `bun run --cwd docs-site check:docs`: pass.
- Not run locally: full Chat suite, integration, WebKit (CI).

Codex review missing (429).
