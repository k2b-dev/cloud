### Map checks after merging newer detail panels

- **What happened:** Contacts map browser tests timed out on hidden addresses and pins, and a retry appeared to move its map. Notebooks skill and documentation checks also failed.
- **Root cause:** The tests assumed addresses stayed expanded across reloads and measured viewport coordinates before a click scrolled to the retry button. Merged skill guidance exceeded the existing size limit, and the new map guide reused the calendar guide's section order.
- **Error class:** Test and documentation assumptions that conflict with independently merged changes.
- **Guard:** `ContactAddressGeo.browser.test.ts` expands the address section before inspecting its contents and scrolls before measuring retry geometry. `packages/notebooks/src/skills.test.ts` retains its instruction size limit, and the documentation check rejects duplicate section orders.
