### The notebook AI action stretched beside View

- **What happened:** “Edit with AI” filled the remaining row and stood taller than “View”.
- **Root cause:** App CSS overrode shared `sm` sizing with a minimum height and flex growth, including the offline button wrapper.
- **Error class:** App CSS overrides shared control sizing.
- **Guard:** Notebooks `detail-panel.browser.test.ts` measures the rendered controls across themes, widths, and interaction states. Both controls keep their shared size props; the row wraps whole controls.
