### A label with actions lowered its field below the neighbour's

- **What happened:** In the Spaces task form, "Estimated duration" sat beside "Due date". Its label row carried
  Gustav's status and **Accept**. That row was taller than a plain label, so the estimate's input box sat about 4 px
  lower than the due date's, and the two boxes did not line up.
- **Root cause:** `@k2b/ui` reserved the suggestion status with a label row of at least 1.5rem (2rem on touch). An
  extra-small button is 1.5rem tall, and a plain label is one 1.125rem line. The row of a field with a suggestion was
  therefore always taller than its neighbour's. Tests checked that nothing moved between suggestion states, but never
  compared a field with its neighbour.
- **Error class:** Content beside a label sets the height of the label row, so neighbouring fields go out of line.
- **Guard:** `.k2b-field__label-row` is exactly as tall as a label line, and a button in it uses that height; on touch
  it keeps its 2.75rem hit area through the shared touch rule. `field-label-row.browser.test.ts` renders two pairs of
  neighbouring fields, each with label actions on one side only. In every suggestion state, the tops and bottoms of
  their controls must match within ±0.5 px.
