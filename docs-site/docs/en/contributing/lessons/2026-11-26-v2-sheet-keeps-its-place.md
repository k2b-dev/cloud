### A sheet left the bottom when its content changed or a script scrolled in it

- **What happened:** On the phone, a popover's sheet whose content got shorter or taller stood off the bottom for a moment, so a tap there hit the backdrop and closed it. On a touch screen, a press that scrolled something in a resting sheet into view (a calendar's step, #4167) moved the sheet's host, and core closed the sheet.
- **Root cause:** Core answers a change of the sheet's height with a spring from the old height, and it has no way to leave that out. On a touch screen, core lets the sheet's host scroll so that a swipe can close it, and it reads every scroll of the host as a swipe. A first fix ignored the host's scroll for a moment after every touch, so a plain tap whose press scrolled counted as a swipe. It also measured the sheet while core slid the host above an on-screen keyboard.
- **Error class:** A gesture inferred from time ("just after a touch") instead of from what the touch did, and a measurement taken while another party's animation moves the measured box.
- **Guard:** `holdSheetBottom` ends core's spring before the frame is drawn, for dialogs and popovers. `holdSheetOpen` puts back a scroll of the host that no touch moved: a glide counts only after a touch that scrolled the host. It corrects nothing while core animates the sheet or its host, and at most once a frame. Tests in `packages/ui/src/v2/overlays.browser.test.ts` and `menus.browser.test.ts`, in Chromium and WebKit, cover:
  - content that gets shorter or taller keeps the bottom in every frame;
  - a script's scroll into view and a tap whose press scrolls the host keep the sheet open;
  - v2 writes nothing to the host while core slides it;
  - a swipe still closes the sheet.
- **Upstream:** Core should dismiss a sheet only after a gesture, and should move a sheet to its new height at once when the content changes. Then both guards can go.
