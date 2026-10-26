### Mail tables broke short numbers inside the token

- **What happened:** The reader broke `Nr.`, `100`, and `110` across lines beside long URLs or code; the composer preview let a long URL widen the table beyond a phone screen.
- **Root cause:** Breaking anywhere on reader cells reduced their min-content width to one character. Composer cells lacked wrapping for long links and code. With only `break-word` in the reader, a plain-text URL in a newsletter cell would widen the newsletter past its own width.
- **Error class:** Break-anywhere lowers table column width.
- **Guard:** Mail `compose-renderer.test.ts` checks the final inlined styles. The `MailMessageBody.browser.test.ts` and `MailComposerEditor.browser.test.ts` table tests cover short tokens and long content in Chromium and WebKit, including reader printing, nested newsletters, resizing, and hidden quoted tables. Cells use `break-word`, links and code inside cells break anywhere, and the reader restores anywhere only for a table that keeping words whole would make wider.
