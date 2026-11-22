# Findings: Solid 2 + @k2b/ssr islands + @k2b/ui v2 on ui-sdk

Spike, 22.11.2026, branch `spike/solid2-ui-v2`. Versions: solid-js 2.0.3, @solidjs/web 2.0.3, @solidjs/babel-plugin 2.0.2,
@ui-sdk/core and @ui-sdk/solid 0.1.0-beta.14, seroval 1.8.0. Inventory of the whole repository:
`~/.local/state/cloud-dev/ui-v2/solid2-inventory.md`.

## Result

It works: Solid 2 renders the pages on the server, islands hydrate their server markup, and ui-sdk supplies the behaviour
of Dialog, Menu, Combobox and sorting. Checked with end-to-end scripts:

| Script | Chromium | WebKit (Playwright 1.65, Docker) |
|---|---|---|
| `test/e2e.ts` (SSR, hydration, Dialog, Combobox, Menu, layout at 390–1920) | 21/21 | 21/21 |
| `test/dnd.ts` (sorting, drag onto a folder; mouse, keyboard, touch) | 27/27 | 16/23, see "WebKit" below |

Conditions:

- The `solid` export condition is needed on the server and in the island build. ui-sdk ships JSX source under it.
- seroval 1.8 (Solid 2 depends on `^1.8`).
- `@solidjs/babel-plugin` replaces `babel-preset-solid`, with `hydratable: true` on both sides.
- Each island is its own hydration root, as described below.

## Real hydration (instead of a client re-render)

- `html()` renders the page inside `<NoHydration>`. Each island re-enters with `<Hydration id>`. Its id comes from
  `createUniqueId()` (the owner tree), so it is deterministic.
- `island-server.ts` renders the `<solid-island data-id data-props data-rid>` wrapper and the tree
  `Hydration > Errored > component`. `mount.ts` builds the same tree and calls `hydrate(…, { renderId })`. If hydration
  fails, the old client render still runs.
- Trap: Solid 2 evaluates the attributes of an `ssrGroup` more than once. A counter in an attribute expression gave the
  wrapper a different id than its children.
- Gains: no node is replaced (MutationObserver check), focus and typed text stay where they are, and the `_$HY` script
  replays clicks and input that happen before the island loads. That makes most of `typed-fields.ts` and the focus
  restore in `mount.ts` (about 180 lines) unnecessary. Not removed yet.
- Costs: 12 ssr unit tests assert the old wrapper markup and need new expectations. The browser and engine tests of the
  ssr package were not run against hydration.

## Drag and drop on ui-sdk (demo: `/dnd`)

| | ui-sdk spike | Our DnD (#3904, #3931) |
|---|---|---|
| Sorting | `createReorder` in a primitive, about 120 lines of binding | `SortableList` + keyboard + place + board, about 760 lines |
| Onto a target | own `createDragOnto` on `bindDrag`, `bindDragPreview`, `createAutoScroll` and `announce`, about 170 lines | `DragAndDrop` + `DropOverlay` + pages + view, about 1,250 lines |
| Library code | ui-sdk core drag-and-drop, 1,751 lines (maintained upstream) | stdlib `dnd.ts`, 1,166 lines (ours) |
| Mouse, keyboard, focus kept, announcements | yes (sorting: ui-sdk; target: ours) | yes |
| Touch | sorting starts after 3 px without a hold (`touch-action: none`, so the item never scrolls); for targets we added a 400 ms hold | 300 ms hold (sorting), 500 ms (targets) |
| Release outside | target: changes nothing; `createTransfer` always takes the nearest list | cancels |
| Rows during a drag | **move live** (the draft is rendered) | stay still until the drop (K7) |
| Drop overlay, levels, move menu, multi-select | not built | built |

Quality: ui-sdk sorting is good: a copy follows the pointer, auto-scroll works at the edges, keys are Space, the arrows,
Home and End, Escape and Tab cancel, and the steps are announced assertively. The sorting is not K7: rows move away during
the drag. That could be bent (render the committed value and draw a line at the draft place), but it works against ui-sdk.
For dragging onto a target, ui-sdk has no behaviour, only parts, so that part stays ours on any architecture. Code size:
the binding is about 5× smaller than ours, but it does not yet have the drop overlay, levels, move menu or multi-select.

Findings from the build:

- `handle.state` in `@ui-sdk/solid` is a plain snapshot (`instance.get()`), not reactive. Render from slot state
  (`slot<{}, { order: string[] }>({ state })` and children as a function), otherwise a drop never shows.
- ui-sdk writes announcements a moment later (batched per turn), so tests must wait for them.
- Hit-testing with `elementsFromPoint` misses the target in WebKit while the copy sits in the top layer. Use rect
  geometry, as ui-sdk's own `listAt` does.
- An island wrapper (`display: contents`) breaks child combinators like `.k2-card > .k2-side`. v2 CSS should not depend
  on direct children across an island boundary.
- **Solid 2 timing bug, reproduced in new code.** On release, `bindDrag` runs the last pending move and then `onEnd` in
  one turn. The move wrote `setOver(target)`, and `onEnd` read `over()`, which still returned the old value. Drops were
  lost or went to the previous target. Fix: imperative logic reads plain variables, and signals only mirror them for
  rendering. This is risk 1 of the inventory in practice: such code typechecks and often passes in Chromium.
- **WebKit.** In Playwright's WebKit (Linux, Docker), the page renders almost no frames while the mouse button is held
  after a drag started: `requestAnimationFrame` gives 32 frames per 500 ms at rest, 0 during the drag, and 4 after the
  copy leaves the top layer. bindDrag batches moves per frame, so nothing moves until the release. ui-sdk's own sorting
  shows the same (its draft does not move during the drag either). Drops still land right, because the state is read at
  release. After such a drag the next `pointerup` was lost once, so the following checks (release outside, keyboard)
  fail as a consequence. Not checked on a real Safari or iPhone; that is needed before any conclusion about ui-sdk on
  WebKit.

## Migration effort (from the inventory, hours, low–high)

| Package | Hours | What the spike showed |
|---|---:|---|
| ssr | 12–24 | Source +148/−75 incl. hydration; 16 test files +55/−54; 12 unit tests need new expectations |
| stdlib/solid | 16–32 | `mutation`, `hotkeys` ported (24 lines, patch). `query` (804 lines) not ported: it needs a design decision |
| ui | 70–130 | Port of v1 only. v2 on ui-sdk is a rewrite (see below), not a port |
| editor | 4–8 | not touched |
| cloud | 40–80 | not touched |
| apps | 140–270 | grids 25–45, mail 25–45, core 10–20, spaces 15–30, notebooks 15–30, the other 21 apps 50–100; not touched |
| other (docs, pwas, tests, scripts) | 20–40 | not touched |
| fibel (separate repo) | 4–10 | peer `solid-js ^1.9`, needs a release |
| **Total** | **~306–594** | big-bang cut: one page cannot load Solid 1 and Solid 2 |

Biggest risks: (1) silent timing changes (reads lag writes until the flush; writes in a compute throw), which matters
most for focus and scroll in Mail; (2) the island and test pipeline (185 files with `babel-preset-solid`, 225 with
`conditions`); (3) stdlib `query`/`mutation` (365 import sites); (4) store setters (117 calls) and `reconcile`;
(5) ui-sdk is a 0.1 beta from a single maintainer, so API churn and the bus factor fall on us.

Third-party blockers: none hard. `solid-codemirror` 3.0 supports Solid 2 (tests only). `@k2b/fibel` needs a release.
`@ui-sdk/*` is a beta.

## What v2 should look like on ui-sdk

- **ui-sdk core** owns behaviour: focus, keys, ARIA, dismissal, positioning, sorting and announcements. No focus or
  keyboard code of our own in `@k2b/ui`.
- **`@k2b/ui` v2** owns look and structure: tokens and flat CSS, plus wrappers that fix the structure (head band, body,
  foot band; rows to the edge), so an app passes content, not layout. German texts through ui-sdk's message options.
- **Own primitives with `definePrimitive`** where ui-sdk has no behaviour: drag onto a target (drop overlay, levels),
  the status line, the move menu. They use the same kernel (store, slots, roles), so agents and tests see them like
  ui-sdk's own.
- **SSR**: ui-sdk parts render on the server (attrs are pure). Islands only where interaction is needed, and each island
  hydrates (ids match). `layoutProblems({ flat: true })` stays the layout check.

## Not done

- ssr: browser and engine tests against hydration; the 12 unit tests; removing `typed-fields`/focus restore; a click
  before the island loads (event replay) is not tested.
- DnD: drop overlay with levels, move menu, multi-select, phone (the sidebar is hidden below 1024 px); K7 "nothing moves
  before the drop" with ui-sdk sorting; a real screen reader (only the live region text is checked); the WebKit frame
  stall on real Safari.
- stdlib `query`, `@k2b/editor`, `packages/cloud`, any real app, dark mode, CI.
