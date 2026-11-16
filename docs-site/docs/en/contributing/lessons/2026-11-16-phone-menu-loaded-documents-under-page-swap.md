### The phone app menu loaded a whole document in apps with page swaps

- **What happened:** In an app with `pageSwap`, choosing a place, tool or page from the app menu behind the page title on a phone loaded the whole document, while the same link in the content swapped the page.
- **Root cause:** `@k2b/ui` `Navigation` renders plain links as `Link` with an `onNavigate` handler that ends in `event.fallback()`, a document navigation, so the page swap's click listener never saw them.
- **Error class:** A shared navigation component that ends its own link handling in a document load, bypassing the host's page swap.
- **Guard:** `Navigation` ends plain links with `swapPage()`, which loads the document wherever no swap is installed or the target is out of scope; `packages/ui/test/navigation.behavior.test.tsx` checks the swap after the host closed its menu, and the app swap contract follows links through the phone menu.
