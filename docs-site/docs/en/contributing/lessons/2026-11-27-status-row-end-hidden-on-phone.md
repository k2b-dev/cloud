### The status row hid its end on the phone

- **What happened:** On the phone, the Assistant's "My apps" lost its filter chips and its action to create a new
  app: the status row hid its end completely below 768 px, so a happy path was gone.
- **Root cause:** One rule of the phone's layout set the end of every status row to `display: none`, as if the end only
  held extras. The narrow form below 600 px already folds the end's controls to their symbols, so most of them would
  have fit.
- **Error class:** Hiding a part to make room, instead of letting it give way, so what a person needs is gone.
- **Guard:** On the phone the end stays: beside the statement where both have room, else in a second line that wraps
  itself where it needs more lines. `status-end.browser.test.ts` draws chips and an action at 390 px and 1440 px in
  Chromium and WebKit: every control is in sight, whole and inside the row, and the wide row keeps its 52 px.
