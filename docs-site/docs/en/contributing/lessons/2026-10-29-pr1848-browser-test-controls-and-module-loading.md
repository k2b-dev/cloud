### Browser tests must follow both states of controls and the bundle loading mode

- **What happened:** Two Contacts WebKit tests timed out reopening an already open address section, and the Studio machine-rights fixture never rendered its load error.
- **Root cause:** The address helper waited for the hidden expand button on its second call; the open section exposes a separate collapse button. The Studio fixture added on main loaded the shared builder's ES module as a classic script. Solid's bundled `addEventListener` function then replaced `window.addEventListener`, and the shared focus listener crashed before rendering.
- **Error class:** Browser test assumptions drift after independently merged UI and build changes.
- **Guard:** `ContactAddressGeo.browser.test.ts` resolves the visible address toggle by role and checks its expanded state; its reconciliation and stale-location tests call the helper twice. `machine-permissions.browser.test.ts` loads its bundle as a module and still asserts load and save recovery without longer timeouts.
