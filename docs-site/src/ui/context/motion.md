# Motion

Use one vocabulary for every time and curve. The tokens are available on
`.k2b-ui` whenever the page loads `@k2b/ui/styles.css`.

| Token | Value | Use |
| --- | --- | --- |
| `--k2b-motion-fast` | `120ms` | Color, hover, press. |
| `--k2b-motion-base` | `180ms` | Pop, slide, fade in. |
| `--k2b-motion-sheet` | `220ms` | Panels, sheets, period changes. |
| `--k2b-motion-celebrate` | `600ms` | Completion moments only. |
| `--k2b-fresh-fade` | `1600ms` | Color only: a highlight fades out. |
| `--k2b-ease-out` | `cubic-bezier(0.23, 1, 0.32, 1)` | Standard curve. |
| `--k2b-ease-spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | Small marks only: check, switch knob, badge. |

Choose the duration by what changes. Use the standard curve for ordinary
entry motion. Reserve the spring curve for small marks and the celebration
duration for completion. A fresh highlight fades its color, without movement.
Existing component times and curves move to these tokens in later migrations.

## State first, animation after

Set state and focus at once. Animation is decoration only. Behavior tests
run without animation and must show the same result.

Popovers and menus get only an entry animation. Closing stays synchronous.

## Keep an interaction within its motion budget

Use CSS and small tree-shakable helpers. Do not add a motion library.

- Read layout at most once per interaction. For FLIP, measure first, then
  animate only the transform.
- Animate only transform, opacity, color, and shadow. Never animate width,
  height, padding, or position.
- Do not animate on first paint or component mount.
- Virtualized lists animate only items that arrived live.
- Keep dense keyboard flows still.

## Respect reduced motion

The operating system's reduced-motion setting or
`data-k2b-motion="reduced"` on `<html>` makes motion inside `.k2b-ui`
instant. Duration tokens become zero, transitions and animations end at once,
and scroll behavior becomes `auto`. Color may still change, movement does not.
A highlight that only fades its color, such as a fresh item, also ends at
once.

Reduced motion sets delays to zero as well. A delay that debounces a
loading indicator, so a fast request never flashes it, is not motion. Keep it
with `!important`, either in a cascade layer or on a selector more specific
than `html[data-k2b-motion="reduced"] .k2b-ui *`. The indicator then still
waits and appears without a fade:

```css
.k2b-ui .my-loader[data-loading] {
  opacity: 1;
  transition-delay: 0.2s !important;
}
```

The attribute is a generic `@k2b/ui` contract. The host page sets it, for
example from a person's profile setting. It reaches `.k2b-ui` elements inside
`<html>`, so put the class on `<body>` or a deeper element:

```html
<html data-k2b-motion="reduced">
  <body class="k2b-ui">…</body>
</html>
```

A component rule that shows something different under reduced motion, such
as a muted track instead of a still segment, repeats right after its media
block under `:where(html[data-k2b-motion="reduced"])`. The selector keeps the
same specificity and cascade position, and the `@k2b/ui` motion contract test
fails when a pair is incomplete.

View transitions belong to the page, not to `.k2b-ui`, so the page that uses
them stops them for both sources. Cloud does this for every Cloud page. A
standalone host adds:

```css
@media (prefers-reduced-motion: no-preference) {
  @view-transition { navigation: auto; }
}
@media (prefers-reduced-motion: reduce) {
  ::view-transition-group(*),
  ::view-transition-old(*),
  ::view-transition-new(*) { animation: none !important; }
}
html[data-k2b-motion="reduced"]::view-transition-group(*),
html[data-k2b-motion="reduced"]::view-transition-old(*),
html[data-k2b-motion="reduced"]::view-transition-new(*) {
  animation: none !important;
}
```

CSS does not reach motion that JavaScript drives, such as
`scrollIntoView({ behavior: "smooth" })` or `element.animate()`. Call
`prefersReducedMotion()` for it. It reads both sources on each call and
returns `false` on the server:

```ts
import { prefersReducedMotion } from "@k2b/ui";

scroller.scrollTo({
  top: target,
  behavior: prefersReducedMotion() ? "instant" : "smooth",
});
```

## Repository check

The `motion` repository check fails on new transitions of layout properties
or layout changes in keyframes in `@k2b/ui` CSS. It warns on new time and
curve literals outside the tokens. Existing findings are counted in a
baseline; migrations remove them. Application CSS is outside this check.
