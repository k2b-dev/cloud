### Mail ignored the person's reduced-motion choice

- **What happened:** Jumping to newest and the HTML message's quoted-text toggle still animated with Reduce motion enabled ([#1230](https://github.com/k2b-dev/cloud/issues/1230)).
- **Root cause:** The jump always requested smooth scrolling, and the sandboxed message only checked the OS setting rather than receiving the host's attribute.
- **Error class:** Motion choice ignored.
- **Guard:** The reader behavior test changes the choice before clicking. The message browser tests cover the initial choice, live changes in both directions, restored transitions, and rejection of frame-originated motion messages.
