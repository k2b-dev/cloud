### Admin apps cut its key figures and an added date, and the layout check never saw it

- **What happened:** In Admin › Apps the head's key figures ("11 Apps · 6 laufen · 2 gestört · 2 laufen n…") faded out mid-figure next to "App hinzufügen" at 390 px, and the address of an app that never started cut its date ("hinzugefügt am 29. Okt. 20…") at 1440 px.
- **Root cause:** Both were one string in a truncating box. The page's browser tests ran Chromium with hidden scrollbars and touch emulation, where columns get more room than in a desktop window with classic scrollbars, and no test checked that figures and dates stay whole.
- **Error class:** Numbers and dates rendered inside a truncating text box, and layout tests that run only with overlay scrollbars.
- **Guard:** `admin/apps/page.browser.test.ts` checks that each key figure is whole or wholly hidden at 390 px and that the added date stays whole at 1440 px; `account-pages.browser.test.ts` runs `layoutProblems` with classic scrollbars at 390, 768, 1100 and 1440 px and fails when no scrollbar takes room.
