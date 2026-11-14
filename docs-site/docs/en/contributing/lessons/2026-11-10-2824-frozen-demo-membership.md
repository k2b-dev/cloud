### Keep new showcases outside frozen demo fixtures

- **What happened:** Adding BalanceFlow to the existing chart gallery increased its parity fixture from 37 to 38 drawings and failed Chromium and WebKit checks.
- **Root cause:** The gallery supplied both live examples and the immutable legacy SVG comparison. A new chart was inserted into that existing-demo fixture despite already having its own catalog showcase.
- **Error class:** Expanding a frozen compatibility fixture with unrelated new behavior.
- **Guard:** `parity.browser.test.ts` still requires exactly the 37 frozen SVGs, their exact markup and matching screenshots at desktop and phone widths in light and dark. The legacy gallery explicitly excludes BalanceFlow; its catalog showcase and all-kind SSR fixture retain it. No frozen reference or assertion changed.
