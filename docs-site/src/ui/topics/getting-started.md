# Getting started

`@k2b/ui/v2` gives screens from fixed parts. The parts own spacing, lines, heights and type; a screen only picks which part stands where and fills it with data. There is no `class`, `style`, `size` or `gap` to tune. v2 is provisional until the maintainer approves it: names and props may change in any release.

## Opt in

In a Cloud app, a page opts in on its `Layout`:

```tsx
<Layout ui="v2" …>
```

The layout puts the scope class `k2-ui` on the page's main area and loads `@k2b/ui/v2.css` with the app's colour. Outside Cloud, the page template puts `class="k2-ui"` on `<body>` and loads `@k2b/ui/v2.css`. A screen never sets `k2-ui` itself.

```tsx
import { Bar, List, Pane, Row, Workspace } from "@k2b/ui/v2";
```

## Start from a recipe

A screen is a component that returns one `Workspace`. Do not compose it from scratch:

1. Find the job on a [topic page](/en/ui) and open its example. The code tab is the whole recipe file, the same file the skill `k2b-ui` ships in `packages/ui/skills/k2b-ui/recipes/`.
2. Copy the recipe, keep its structure, replace the data. Strings come from the app's message catalog; recipes write German sample text only to look like the real thing.
3. Something has no part? Use the nearest one and write `// k2b-ui gap: <what is missing>` at that place. Each topic's "Not in v2 yet" lists the known gaps.

## Check what you built

Cheapest first; stop at the first step that finds something, fix it, and run again.

```terminal Check one screen in the Cloud monorepo
$ bun packages/ui/scripts/v2-preview.ts path/to/screen.tsx --text
# types, the rule v2-app-layout-css and the describeV2 outline, without a browser
$ bun packages/ui/scripts/v2-preview.ts path/to/screen.tsx --png out
# also the layout measured at 1440 and 390 px, and a screenshot of each
$ bun scripts/check.ts v2-app-layout-css
# the rule for every screen of the repository
```

- **Types** reject wrong props, such as an icon button without `label`.
- **The rule `v2-app-layout-css`** reports `class`, `style`, spreads and stylesheets outside `Canvas`.
- **The outline** of `describeV2` lists every part with its text and ends with `Problems` when something is off.
- **The measurement** (`measureV2Layout`) checks edges, double lines, type roles and grips at 1440 and 390 px.

The [rules](/en/ui/v2/rules) say why each of these holds.

## For agents

The skill `k2b-ui` ships with the package and says which part to use for what. Each topic page here is also Markdown for search and `read_doc`, with the recipe's code and the generated props.
