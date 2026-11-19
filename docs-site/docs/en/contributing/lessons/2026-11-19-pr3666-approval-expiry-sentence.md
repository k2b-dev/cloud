### Keep the reason an approval ended in its visible sentence

- **What happened:** An expired approval said only that its action had not run. The card no longer explained why the person needed to ask again.
- **Root cause:** The compact card omitted the quiet expiry detail to avoid repeating the state, but its main sentence still used the generic not-run form.
- **Error class:** Moving state between presentation slots without preserving its meaning.
- **Guard:** `blocks.render.test.tsx` checks the real chat outcome in German and English: the expiry reason appears exactly once, with an empty quiet line. `approval.behavior.test.tsx` keeps the visible Ask again path and verifies that it sends a new question without repeating the action.
