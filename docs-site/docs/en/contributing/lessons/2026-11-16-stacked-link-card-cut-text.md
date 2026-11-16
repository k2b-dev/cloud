### A stacked link card cut its title and schedule

- **What happened:** On "My apps & automations" a long Code title ended in "Wochenabschluss Wareneingang (frei…" and its schedule in "Alle 15 Minuten von 7:00 bis 19:…", so the end time was lost.
- **Root cause:** The stacked `LinkCard` in `@k2b/ui` (`surfaces-widgets-parity.css`) kept the classic card's one-line title and description with `text-overflow: ellipsis`, although a stacked card names one thing in full and has room to grow; its row already ends level.
- **Error class:** A layout variant inherited a truncation rule from its base variant without asking whether the variant needs it.
- **Guard:** `link-card.browser.test.ts` checks at 1440 and 390 that a long stacked title and description wrap without an ellipsis and stay inside the card.
