### Mail's "+ Tag" chip and calendar bars cut off descenders

- **What happened:** In the Mail conversation head, the bottom of the "g" in "+ Tag" was cut off, and so were the descenders of the other chip labels in that row, such as "Waiting for reply". Calendar bars in the month view, the day list, all-day rows and week slots cut off the descenders of their titles in the same way.
- **Root cause:** `.mail-reader-chip` and the calendar bar rules set `line-height: 1` to center a single line. Their labels and titles clip overflow for the ellipsis (`overflow: hidden`), so the box that clips is only one em high. IBM Plex Sans needs about 1.3 em from ascent to descent.
- **Error class:** A line box shorter than the font's ascent and descent on an element that clips its overflow.
- **Guard:** The clipping labels and titles use `line-height: normal`; the fixed chip or lane height still centers them. `MailReaderHead.browser.test.ts` and `calendar-month.browser.test.ts` measure each label's text range, which spans the font's ascent and descent, against the label's box and check that the chip and lane heights stay the same.
