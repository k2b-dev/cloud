### Leave out a hint where it has no room instead of hiding it with CSS

- **What happened:** After any Command or Control shortcut, the Notebooks selection toolbar showed "⌘ B", "⌘ I" and "⌘ K" across its 30 px icon buttons for the rest of the page.
- **Root cause:** `SelectionToolbar` hid the hints with `display: none`, but the general `.k2b-toolbar .k2b-toolbar__hint` rule had the same specificity, came later and turned them back into `display: flex`. The sticky keyboard flag then made them visible.
- **Error class:** A state-dependent element hidden by an override that loses the cascade to an equally specific rule.
- **Guard:** `Toolbar.Action` does not render the hint inside `SelectionToolbar`; `selection-toolbar.browser.test.ts` presses the shortcut in an editable text in Chromium and WebKit and checks that no `Kbd` is rendered, the button keeps 30 px, and the tooltip names the shortcut.
