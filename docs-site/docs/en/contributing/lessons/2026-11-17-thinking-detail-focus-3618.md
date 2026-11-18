### Temporary step details must hand focus back

- **What happened:** Keyboard focus fell to the page body when a running thinking step lost its duration detail button.
- **Root cause:** The step removed its focused detail trigger without moving focus to the work overview; a turn without tools also removed the overview despite the person having opened it.
- **Error class:** A transient control disappears without a focus handoff.
- **Guard:** The thinking-details focus browser regression checks the next step and turn completion, a visible overview focus ring, stable layout, and focus that the person already moved away.
