### Assistant chat details looked unlike every other Details

- **What happened:** The Assistant's **In this chat** column was reported twice as looking different from Mail and the other applications: its own surface, header, width, and phone sheet instead of the shared Details (#1808).
- **Root cause:** The Assistant rendered the shared `DetailPanel` in its own column, drawer, and bottom sheet inside the chat pane, so later changes to `AppWorkspace.Detail` (surface, header rhythm, resize edge, shadow, phone page) never reached it. Flattening the sections in #1661 fixed one symptom, not the host.
- **Error class:** An application recreates a shared layout host around a shared component.
- **Guard:** The Assistant contract test requires `<AppWorkspace.Detail` with `phone="page"`, and its browser suite checks the column, drawer, phone page, and flat sections. In `@k2b/ui`, a reopenable phone page waits behind its control, covered by `detail-float.browser.test.ts` and `app-workspace-controller.behavior.test.ts`, so a default-open Detail does not cover the phone screen on load.
