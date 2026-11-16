### The composer suggested the word "null"

- **What happened:** The suggested next message in the composer read "null", with "Tab übernehmen" beside it.
- **Root cause:** The suggestion tool takes `text: string | null` and asks for null when no suggestion helps. A model wrote the word "null" as a string; the check only refused empty text, so the word was saved and shown.
- **Error class:** A placeholder for nothing reached the UI as text.
- **Guard:** One rule, `aiNextMessageText` in `ai/next-message-text.ts`, holds where a suggestion is made and where a stored one is read: no placeholder word, and at least `AI_NEXT_MESSAGE_MIN_CHARS` (6) characters, below which a suggestion is noise. `next-message.test.ts` rejects "null", "undefined", "None", "ok" and "Danke"; the integration test reads a stored "null" back as no suggestion.
