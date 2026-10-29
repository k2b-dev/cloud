### iPad installation guidance changed after the page loaded

- **What happened:** iPadOS Safari initially showed the Cloud app’s phone-only message, then changed it after mount.
- **Root cause:** Its Mac user agent selected the desktop text on the server; a client pointer check corrected it later.
- **Error class:** Server and browser platform detection choose different initial content.
- **Guard:** The start-page render tests require both iPad installation steps and the computer hint for the Mac-style iPadOS user agent in English and German. CSS selects the visible variant before JavaScript runs; a behavior test checks that mounting retains both variants.
