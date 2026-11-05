### The access dialog cut off levels, marks and names on a phone

- **What happened:** At 390 px the shared access dialog showed "Bearbeit…" as a level, marks such as "Wird entfern…" and "vorher Ansehe…" cut off, names such as "Mia Hoffmann" on two lines, and "Alle angemel…" in the General section. The existing browser test passed, because it only checked that no row moved and that nothing overflowed.
- **Root cause:** A merge combined a fixed 7 rem level column with a name column that wraps. Together with the remove button, they left the name and its mark about 84 px. The General row kept its mark beside the name on a phone. A plain `k2b-dialog` frame also used the browser's wider dialog margin instead of the dialog budget that panel dialog frames already use.
- **Error class:** A layout test that checks only for overflow passes while text is cut off inside its own box or by an ancestor that clips.
- **Guard:** `AccessDialog.browser.test.ts` stages the longest level pairs at 390 px in German and English. It fails when a mark, a level or a name is clipped by its own box, by a part of it with an ellipsis, or by a clipping ancestor. It also fails when a name wraps.
