---
title: Write a UI topic page
navTitle: UI topic pages
section: Contributing
order: 1303
description: Add or finish a topic page of the UI section, with live examples from the recipes of the skill k2b-ui, their states and generated props.
tags: [contributing, documentation, ui]
updated: 2026-11-25
---

# Write a UI topic page

The UI section shows `@k2b/ui/v2` by task: each topic page answers one job on a screen, such as "Lists and tables". It shows real screens, not single widgets. The code of every example is a recipe of the skill `k2b-ui`, so the preview, the code tab, the skill pictures and the overview thumbnail come from one file.

## Where things live

```tree The files of the UI section
packages/ui/skills/k2b-ui/recipes/   # one whole screen per file: code, preview, picture
docs-site/src/ui/topics/
  lists-and-tables.md                # a topic page (the reference page)
  screens.md                         # the page "Whole screens"
  recipes.ts                         # every recipe, one import line each
  topics.ts                          # the topics in their order
  topics.test.ts                     # shape, Markdown twin, props
  topics.browser.test.ts             # every recipe and state live in a browser
```

Each topic file belongs to whoever writes it. Change only your own topic files and recipes.

## Add a recipe

1. Write the screen as `packages/ui/skills/k2b-ui/recipes/<name>.tsx`. Its first line is `// Recipe: <what it shows>.` Its default export renders without props.
2. Add one import line to the `recipes` object in `docs-site/src/ui/topics/recipes.ts`. The test fails while a recipe file is missing there.
3. The recipe renders in German, the language of its sample text, so the library's own words ("Erneut versuchen", "Rückgängig") match it. A recipe in another language exports `export const locale = "en"`.
4. Check it with `bun packages/ui/scripts/v2-preview.ts <file> --text`. The skill-recipes browser test checks every recipe at 1440 and 390 px.

## Give a recipe its states

A recipe exports its other states next to the screen. The default export may take optional props for them:

```tsx
export const states = {
  empty: () => <OpenInvoices rows={[]} />,
  loading: () => <OpenInvoices loading />,
  failed: () => <OpenInvoices failed />,
  menu: { render: () => <Offers />, press: "Aktionen für Regal Archiv" },
  confirm: { render: () => <Members />, press: ["Aktionen für j.wolf@…", "Zurückziehen"] },
};
```

- A function renders the state on the server and in the browser.
- `{ render, press }` is for overlays (`Menu`, `Popover`, `Dialog`, toasts). They render nothing on the server and open only through their real behaviour. After hydration the page presses what `press` names, in order: the accessible name of a button, then the names of menu items.
- The live route is `/en/ui/v2/recipe/<name>?state=<state>`. Its root `.ui-v2-recipe` has `data-recipe="ready"` when the screen stands as the state asks, or `missing: <name>` when a press found nothing. Tests and screenshots wait for `ready`.
- The skill-recipes test renders every state from its server markup. A `press` state needs its own browser test after the press.

## Write the topic page

A topic page is one Markdown file. Its front matter feeds the overview:

```md
---
thumbnail: table
---
```

Give `thumbnail` a recipe name for the live picture in the overview. While the page is unfinished, add `status: stub` and `parts: A · B · C`.

The sections are fixed, in this order. The test `topics.test.ts` checks them:

1. `# Title`, then one or two sentences: when to use this.
2. One or two example sections (`## A table to compare`): a short text and an `Example`.
3. At most one choice, `## List or table?`, with a `###` list for each side.
4. `## Parts`: one `### Name` per part, one line that says what it is, and its `Props`.
5. `## Not in v2 yet`: what is missing, and that the place gets a `// k2b-ui gap: …` comment.
6. `## Do and don't` with `### Do` and `### Don't`, 1 to 4 points each.
7. `## Next`: one link to the next topic.

Two placeholders, each on its own line, stand for the live parts:

```md
<Example recipe="table" height="440" default="Rows" />
<Props of="Table Column" />
```

- `Example` takes the recipe name, the screen height at a desktop width in px (the phone adds 15 %), the label of the default state, and optionally a fixed `width` of 1440, 1024 or 390.
- `Props` takes components, dotted parts such as `Pane.Split`, and exported object types such as `Column`. A name that does not exist fails the build.

States have no section of their own: the `Example` switches them. The rules for empty, loading and failed stand once, in "States and notices".

## Props come from the types

`Props` reads the types of `@k2b/ui/v2` with the type checker, on the same path as the rule `v2-primitive-props`. The description of a prop is the first sentence of its TSDoc. A prop without TSDoc shows "–", so write the TSDoc in `packages/ui/src/v2` and not on the page. The props of a union become alternatives ("With `markdown`", "Or with `children`"). A prop marked as required there is required only in its variant.

## What agents read

Search, `read_doc` and llms.txt get a Markdown twin of the page. Each `Example` becomes the recipe's path, its states and the whole file in a code block. Each `Props` becomes a Markdown table. Check your page with the docs MCP of a local build: `read_doc` with `/en/ui/v2/<slug>` must return your prose, the code and the tables.

## Check your page

```terminal Focused checks for a topic page
$ bun test src/ui/topics/topics.test.ts
$ bun test src/ui/topics/topics.browser.test.ts
$ bun test ../packages/ui/src/v2/skill-recipes.browser.test.ts
$ bun run check:docs
```

Run the commands in `docs-site`. The browser test opens every recipe and state on its live route, so a new recipe needs no new test line.
