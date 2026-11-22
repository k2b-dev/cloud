### A changed Files poll rebuilt every row and lost scroll and focus

- **What happened:** When the 20-second folder poll in Files brought a change, such as one renamed file, every `div.filesv2-list__row` was rebuilt. The list scrolled back to the top and a focused Details button lost focus to `body`, in Chromium and WebKit, at 1440 and 390 px (#3991).
- **Root cause:** `FileList` rendered its rows with `<For each={props.rows}>`, keyed by object identity. A changed poll loads the folder again and brings new objects for every entry, so `For` replaced every row element.
- **Error class:** A list that is refreshed from the server keys its rows by object instead of by a stable id, so a refresh with new objects re-creates unchanged rows.
- **Guard:** `packages/filesv2/src/frontend/LiveRefresh.browser.test.ts` scrolls a 60-file folder, focuses a row's Details button, lets a fake-clock poll return one renamed file, and checks that `scrollTop` and the focused element stay the same. `FileList` now keys rows by path and reads each row's current object in place.
