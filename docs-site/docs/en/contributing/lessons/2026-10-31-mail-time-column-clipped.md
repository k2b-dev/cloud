### Mail's columns view cut off the start of relative times

- **What happened:** In the Mail columns view, German times such as "vor 15 Stunden" lost their first letters ("r 15 Stunden"), and "vor 1 Stunde" fit only in some rows.
- **Root cause:** The time column had a fixed 4.5rem track sized for short English values. Its right-aligned, overflow-hidden cell cut longer localized values off at the start.
- **Error class:** A fixed width for text whose length depends on locale and data, chosen from one sample value.
- **Guard:** The columns view sizes the time column to the longest localized samples (`mailTimeColumnSamples`), measured in the row font. `MailConversationList.browser.test.ts` checks that the longest German and English times fit at the narrowest list in Chromium and WebKit, and that every row keeps one column.
