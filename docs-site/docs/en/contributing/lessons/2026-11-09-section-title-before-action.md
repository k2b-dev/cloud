### A Section title gave way to its action on a phone

- **What happened:** On a phone, the Contacts comments section showed "Not…" instead of "Notizen". The count ("Noch keine") and the action "Kommentar hinzufügen" kept their full width.
- **Root cause:** The heading row kept the action at full width (`flex: 0 0 auto`). The title could shrink to nothing (`min-width: 0` with an ellipsis). In a 350 px card the title was the only part that gave way.
- **Error class:** A flex row where the most important text has the lowest shrink priority.
- **Guard:** In a heading with an action, the title block keeps its natural width up to the row beside the icon, and the row may wrap. The action moves to a second line at the end before the title truncates. `section.browser.test.ts` checks this at 390 px for the German Contacts case: no wrap where everything fits, and an ellipsis only for a title longer than the row.
