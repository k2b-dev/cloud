---
id: notebooks-structured-blocks
title: "Structured blocks"
icon: "ti ti-braces"
description: "Use @ref blocks to make tables, lists, todos, data, and sections script-readable."
order: 130
---

Named blocks are the bridge from readable notes to script-readable data. Put a stable `@ref` directly above the block that should become part of the public note structure.

**@ref**

## The block contract {icon="contract"}

:::reference
- **Stable names:** Use short lowercase names such as @plants or @tasks. Rename carefully because scripts call those names.
- **One name, one meaning:** Do not reuse the same name for different concepts. Automation should not have to guess which block to use.
- **Visible data:** Keep source data visible in Markdown so another user can understand the script without reading code first.
- **Script access:** Scripts read blocks with helpers such as current.table("plants"), current.todo("tasks"), and current.data("recipe").
:::

**Structured data**

## Tables {icon="table"}

Tables work well for small structured lists such as plants, recipes, contacts, books, tasks, or expenses.

**Named table with formulas**

```text
@plants
| Plant | Bed | Status | Progress | Notes |
|---|---|---|---|---|
| Tomato Harzfeuer | Bed A | planted | =PROGRESS(2,4) | keep rain off leaves |
| Bush bean | Bed B | next | =PROGRESS(0.25) | sow into warm soil |
| Chives | Bed C | harvest | =PROGRESS(1) | leave some flowers |
```

**Other blocks**

## Lists, todos, data, and sections {icon="braces"}

:::reference
- **Table:** Rows and columns. Scripts receive columns and row objects.
- **List:** Bullet items. Useful for small named collections.
- **Todo:** Task items with done/content/line metadata.
- **Data:** YAML-like data block parsed as an object.
- **Section:** Named Markdown section that scripts can read or append to.
:::

**Data sources for scripts**

```text
@recipe
:::data
servings: 4
time: 35 min
tags:
  - bavarian
  - weeknight
:::

@shopping
- flour
- eggs
- mountain cheese

@tasks
- [ ] Grate cheese
- [x] Slice onions
```
