### A focused tab that hid dropped the focus to the page

- **What happened:** In a v2 head at 1440 px, the keyboard focus stood on the tab "Reklamationen". When the window
  narrowed to 390 px, the tab had no room and hid, and the focus fell to the page. A keyboard user lost their place.
- **Root cause:** `Tabs` hide a tab without room with `visibility: hidden` (`data-overflow`), and the browser takes
  the focus away from a hidden element. Nothing gave the focus to the menu tab that now holds the hidden tab. The
  bar's fold (`bar-fold.ts`) hands the focus of a folding button to its "…", but `Tabs` measure on their own.
- **Error class:** A control that holds the focus and hides or goes, with no new place for the focus.
- **Guard:** `Tabs` set the count of tabs in sight in one place, and that place hands on the focus: a hiding tab
  gives it to the menu tab ("Mehr" or the views' own), and a "Mehr" that goes gives it to the last tab.
  `menus.browser.test.ts` focuses a tab, narrows the window to 390 px and back, and checks `document.activeElement`
  in Chromium and WebKit, for "Mehr" and for a head's own menu tab ("Weitere").
