### A German Mail action failure quoted an English service detail

- **What happened:** A failed Mail action in a German chat read "Die Eingabe ist ungültig: A verified sender identity is
  required". The specific sender case was fixed for `draft.create` and `draft.send` in #3793, after the shown turn
  ran. Every other Mail action and query still put the English service detail behind the German frame.
- **Root cause:** The capability boundary chose per action name whether a German input error kept its detail. Only
  the two draft actions used Mail's catalog sentence, so the next action that failed with an English service
  message repeated the same line.
- **Error class:** A translated frame around untranslated dependency text; a per-call-site opt-out instead of a safe
  default.
- **Guard:** Mail's capability boundary never appends a service detail to a German message. Only rejections the
  capability itself writes in the request locale keep their words. `capabilities.test.ts` covers an action (review
  keeps its localized words, run gets the catalog sentence instead of the English detail) and a query, in `de`,
  `de-CH` and `en`.
