### Grids field settings could only be opened from the table view

- **What happened:** A base editor in a card view, a calendar, a grouped table, or a saved view had no way to open an existing field's settings. They had to switch to the plain table view and use a column header (#2032).
- **Root cause:** The only entry point was the settings button in `DatabaseTable`'s column headers. `RecordsResultSurface` passed `onFieldSettings` to that table alone, so every other display mode rendered fields without it.
- **Error class:** A table-level action placed inside one display mode's rendering instead of in a surface that every display mode shares.
- **Guard:** Edit mode's toolbar offers a **Fields** menu in every display mode. `RecordsView.behavior.test.tsx` opens it in the table, card, calendar, grouped, and saved views and checks that people without table management do not get it. The Chromium suite `database-table.browser.test.ts` checks the card view's menu at desktop and phone widths.
