# See what you built

You cannot see the screen. Four kinds of feedback replace the look, from the
cheapest to the most expensive. Run them in this order after every change
and fix what the cheaper one finds before you pay for the next.

| Step | Cost | Finds |
| --- | --- | --- |
| types | free with the build | wrong or missing props, an icon button without a name, two `Chip` kinds |
| rule `v2-app-layout-css` | ~1 s | `class`, `style`, spreads, `innerHTML`, stylesheets outside `Canvas`; a `Canvas` in the wrong place |
| outline (`describeV2`) | ~30 lines of text | the structure, every text, counts, hidden parts, `Problems` |
| layout (`measureV2Layout`) | a browser | lines short of the edge, double lines, text off the four type roles, grips off their line |
| screenshot | an image per width | everything else; only when in doubt |

## In the Cloud monorepo

`packages/ui/scripts/v2-preview.ts` runs all steps on one screen file
whose default export is a component without props:

```bash
bun packages/ui/scripts/v2-preview.ts packages/my-app/src/screens/sources.tsx --text
bun packages/ui/scripts/v2-preview.ts packages/my-app/src/screens/sources.tsx --png .local/shots
```

- `--text`: types, rule and outline from the server markup, no browser.
  Use it after every edit.
- without `--text`: Chromium at 1440 and 390 px (`--width` to change),
  outline with layout (hidden parts, dropped columns) and the measurement.
- `--png <dir>`: also a light screenshot per width.
- Exit code 0 means every step is clean.
- On a shared machine, run the browser variant through its load wrapper.

`bun run check` runs the rule on every app; `bun run --cwd packages/<app>
typecheck` runs the types.

## The outline

`describeV2` reads the `data-k2-part` marks. One line per part, indented by
nesting, slots named (`head:`, `status:`). Words in brackets are buttons,
in parentheses chips, `@Name` an avatar. A long list shows three entries
and `… n more`. The `Problems` block names what a person would see as
wrong:

```text
Workspace (sidebar, head) primary "Neue Quelle"
  Nav "Pulse": 2 entries, current "Quellen"
  head: Bar: Tabs "Ansichten": Alle (3) ✓, Gestört (1) | ["Neue Quelle" primary]
  Pane.Split
    Pane "Quellen" width 320px–400px
      status: StatusRow "3 Quellen" · 1 gestört
      List "Quellen": 3 entries
        Row "Lackfabrik Nordhaus" / "Webhook" · 09:42 opens link
        …
    Pane "Holzwerk Brandt" detail
      head: Bar: "Holzwerk Brandt" lead | ["Bearbeiten"] ["Schließen" ghost link]
      Notice bad "Antwortet nicht": "Seit gestern, 17:20 …" ["Erneut prüfen" text]

Problems (1):
- plain <div> in Pane "Quellen" "lose": no primitive owns it; use Band, …
```

Compare your outline with the task, not only with the problems: is every
required part there (the error state, the empty state, the main action, the
phone)? At 390 px the outline says which parts are hidden and which table
columns dropped.

## Outside the monorepo

`@k2b/ui/v2/testing` brings the same checks to a Playwright test of your
app (Playwright is an optional peer dependency of `@k2b/ui`):

```ts
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";

for (const width of [1440, 390])
  test(`the sources screen at ${width} px`, async () => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(url);
    expect(await describeV2Page(page)).not.toContain("Problems");
    expect((await measureV2Layout(page)).problems).toEqual([]);
  });
```

Print the outline (`console.log(await describeV2Page(page))`) when you
need to see the screen. With server markup and no browser (happy-dom,
linkedom), call `describeV2(element)` from `@k2b/ui/v2` without `layout`.

## Screenshots

Ask for one only when the outline cannot answer the question: does the
drawing in a `Canvas` fit, does a long name read well, is the phone layout
what the task meant. Light mode, 1440 and 390 px. Compare it with the
recipe pictures in `images/`.
