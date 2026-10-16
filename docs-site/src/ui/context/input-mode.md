# Input mode

`installInputModeController()` records input on `<html>` so actions and
keyboard hints follow how the person works.

| Attribute | Meaning |
| --- | --- |
| `data-k2b-input="touch"` | The latest pointer was a finger or pen. Row actions stay visible. |
| `data-k2b-input="trackpad"` | The latest pointer was a mouse or trackpad. Row actions show on hover. |
| `data-k2b-kbd="on"` | A key was pressed outside a text field. Keyboard hints show. |

Pointer down and pointer move update the input mode from `pointerType`,
including on an iPad with a trackpad. Compatibility mouse events after a tap
do not change it. Typing in a text field, AltGraph characters, composition,
and lone modifier or lock keys do not enable keyboard hints. Tab and Ctrl or
Command shortcuts count inside a text field too.

Neither attribute exists before its first qualifying event. Server HTML and
the first browser frame stay identical. A browser cannot tell whether a
keyboard is attached, so hints wait for a qualifying key press. The keyboard
flag stays for the document, including after pointer use or controller cleanup.
A full page load starts without it.

## Start the controller

In any SolidJS host, start it on mount and remove its listeners on cleanup:

```tsx
import { installInputModeController } from "@k2b/ui";
import { onCleanup, onMount } from "solid-js";

onMount(() => onCleanup(installInputModeController()));
```

Cloud's shell starts it on every Layout page. Other hosts start it themselves.
The function also accepts a `Document`, returns a disposer, and does nothing
on the server. Repeated installation has the same effect; each disposer
removes its own listeners and leaves the attributes in place.

Put `.k2b-ui` on `<body>` or a deeper element so selectors from `<html>` reach it:

```html
<html>
  <body class="k2b-ui">…</body>
</html>
```

## Keep space reserved

Mode changes may only change opacity, visibility, or pointer-events of an
element whose space is already reserved. They never change size or position.
Prefer `k2b-progressive-row` and `k2b-progressive-action` for your own rows;
see [Getting started](/en/ui/getting-started).

For a custom action, pair its rest rule with the same declarations. Without
an attribute, `any-hover` keeps the default behavior. Touch overrides hover
capability; trackpad overrides its absence. `:where()` preserves specificity.
Keep reveal rules after both rest rules:

```css
@media (any-hover: hover) {
  :where(html:not([data-k2b-input="touch"])) .k2b-ui .my-action {
    opacity: 0;
  }
}
:where(html[data-k2b-input="trackpad"]) .k2b-ui .my-action {
  opacity: 0;
}
.k2b-ui .my-row:is(:hover, :focus-within) .my-action,
.k2b-ui .my-action:has([aria-expanded="true"]) {
  opacity: 1;
}
```

Do not use primary-pointer queries such as `(hover: hover)` for this decision:
a tablet's primary pointer can stay coarse while a mouse is in use.

## Show keyboard hints

Add `k2b-kbd-hint` to `Kbd` or a wrapper around a shortcut hint:

```tsx
<Kbd keys="mod+k" class="k2b-kbd-hint" />
```

It starts with `visibility: hidden`, keeping its box while hiding it from
assistive technology. `data-k2b-kbd="on"` makes it visible. Use it for optional
hints that repeat a shortcut, such as toolbar labels. Shortcut lists and help
always show their keys; see [Kbd](/en/ui/content/kbd).
