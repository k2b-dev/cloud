### Assistant reconnect notice moves the page

- **What happened:** When the live connection dropped for a moment, the Assistant's reconnect notice moved the title, the composer, and the starters on the new-chat page ([#1159](https://github.com/k2b-dev/cloud/issues/1159)).
- **Root cause:** The notice above the composer is mounted only while it shows, so it takes a new line in the layout flow.
- **Error class:** Layout shift.
- **Guard:** Pending in [#1159](https://github.com/k2b-dev/cloud/issues/1159): the notice gets a place that the page reserves, and a browser test compares the places of the title, the composer, and the starters before and during a reconnect. The class rule is [Keep the layout still](/en/docs/frontend/styling-and-accessibility#keep-the-layout-still).
