### Mail printed a dark conversation as light text on white paper

- **What happened:** In dark mode, Print conversation printed the subject and plain-text bodies in near-white text on white paper. Both labels of the quoted-text toggle printed on top of each other, and the sender rows were missing in both themes ([#1175](https://github.com/k2b-dev/cloud/issues/1175)).
- **Root cause:** The print rules made only the reader root white and black, so its content kept the dark theme's text colors. They forced `visibility: visible` on every element in the reader, which also showed the hidden toggle label. They also hid every button, and the message header with the sender and date is a button. Cloud has no light theme scope that also covers the Tailwind `dark` variant and the `@k2b/ui` component rules.
- **Error class:** Theme in print.
- **Guard:** Mail hides only what lies outside the reader, keeps the message header on paper, and prints a dark reader as black ink without dark surfaces. The Mail printing browser test runs the real Print action in Chromium and WebKit. [#1274](https://github.com/k2b-dev/cloud/issues/1274) proposes a light print theme for every page.
