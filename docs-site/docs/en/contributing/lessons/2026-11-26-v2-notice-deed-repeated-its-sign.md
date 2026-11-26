### A notice's deed repeated the notice's sign

- **What happened:** In the offline notice of a Cloud page (PWA), the refresh symbol stood twice: as the notice's sign at its start and on its deed "Neu laden" at its end.
- **Root cause:** A `Notice` drew each deed with the symbol the app gave it, and the app gave the deed the same symbol as the notice, because both say "reload".
- **Error class:** Two parts of one primitive that each take a symbol from the app show the same one twice, and neither knows the other's.
- **Guard:** `Notice` leaves a deed's symbol out when it is the notice's own sign. `packages/ui/src/v2/notice-primary.browser.test.ts` ("a notice's deed does not repeat the notice's sign") checks this in Chromium and WebKit, and checks that a deed with a symbol of its own keeps it.
