---
id: notebooks-troubleshooting
title: "Troubleshooting"
icon: "ti ti-lifebuoy"
description: "Fix common Markdown, @ref, formula, script, attachment, and search problems."
order: 180
---

Most Notebooks issues come from one of four contracts: Markdown syntax, stable `@ref` names, enabled scripts, or notebook-scoped permissions.

**Troubleshooting**

## Common symptoms {icon="stethoscope"}

:::reference
- **A script cannot find a table:** Check that the table has a stable @name directly above it and that the script uses the same name.
- **A formula shows an error:** Check function spelling, argument count, column names, and circular references. Column names with spaces need backticks.
- **A script does not run:** Check that script blocks are enabled in notebook settings and that the code is inside a script fence.
- **Search misses a note:** Tags are parsed from #tag markers. Structured tag filters require all listed tags to be present.
- **An attachment is missing:** Confirm the file exists in the notebook and that the Markdown reference uses attach://shortId.
- **A script writes the wrong place:** current writes update the note containing the script. nb.update only moves another note in the current notebook tree.
:::

**When stuck**

## Debug path {icon="route"}

:::steps
1. **Read the note first:** Make sure the raw Markdown contains the data you expect.
2. **Check named blocks:** Verify @ref names and use plural helpers such as current.tables() for discovery.
3. **Use small scripts:** Start with ui.text or ui.table before adding buttons, prompts, charts, or writes.
4. **Keep changes reviewable:** Prefer Markdown updates and named blocks over hidden state when other users need to understand the result.
:::
