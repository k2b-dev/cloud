### Identity confirmation forgot the remembered sign-in method

- **What happened:** Confirming one's identity always opened the login page on the fallback credential, although the same page normally preselects the method the browser remembered.
- **Root cause:** The identity-confirmation link forced the fallback credential and overrode the remembered app choice.
- **Error class:** A continuation overrides a remembered choice.
- **Guard:** Tests: Core `approval-dialogs.browser.test.ts` follows the real confirmation redirect; `page.browser.test.ts` compares app and email selection on normal and confirmation visits, including alternate-method links.
