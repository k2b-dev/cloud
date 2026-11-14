### A status reserve that only grows leaves the live chat empty

- **What happened:** In a live Gustav turn, long text that the model wrote between steps was shown whole (#3332). When a short status replaced it, the view showed almost only empty space below the new line (#3333).
- **Root cause:** Place 3 of `AiTurnView` kept a `min-height` that only grew during a turn. It took the largest height of any earlier status and the full answer height of a quiet text, so one long block reserved its height until the turn ended. Quiet text had no length limit.
- **Error class:** A layout reserve against movement that has no upper bound, so it outlives the content it was meant to hold steady.
- **Guard:** Quiet text shows at most three lines, and the reserve is capped at that height. `live-turn.browser.test.ts` measures the space below a short status that replaced a long one. It also checks that the chevron and everything above the text stay where they are when the text opens or closes, and that the final answer shows whole.
