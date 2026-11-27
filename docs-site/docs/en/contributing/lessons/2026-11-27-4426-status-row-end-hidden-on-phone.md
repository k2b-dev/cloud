### The status row hid its end on the phone

- **What happened:** On the phone, the Assistant's "My apps" lost its filter chips and its action to create a new
  app: the status row hid its end completely below 768 px, so a happy path was gone.
- **Root cause:** One rule of the phone's layout set the end of every status row to `display: none`, as if the end only
  held extras. The narrow form below 600 px already folds the end's controls to their symbols, so most of them would
  have fit.
- **Error class:** Hiding a part to make room, instead of letting it give way, so what a person needs is gone.
- **Guard:** On the phone the end stays in the row's one line of 52 px: what has no room beside the statement, shortened
  to 40 % of the row, folds into one "+n" through the bar's fold (`watchFold`), which opens it as a menu (a pressed
  chip with its check); its name says how many it holds ("3 weitere Filter"). `status-end.browser.test.ts` draws
  buttons and chips in an `Inline` at 390 px and 1440 px in Chromium and WebKit, and the table demo keeps its 52 px.
