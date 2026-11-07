### Validate and inspect Sankey charts at their real host boundaries

- **What happened:** Invalid locale strings could make a saved chart throw; a reversed scroll container reversed tooltip rows and misplaced their anchors.
- **Root cause:** JSON accepted arbitrary locale strings, and scroll direction and coordinate conversion were used without testing a scrolled chart outside the demo wrapper.
- **Error class:** Unvalidated rendering metadata and mismatched scroll coordinate spaces.
- **Guard:** Cloud model-schema tests reject invalid BCP 47 locales. The Sankey browser test checks source-first scroll position, keyboard reveal, tooltip anchor geometry, controlled selection, standalone paint and dark text. Layout tests cover dense columns, minimum flow widths and private slots for skipped stages.
