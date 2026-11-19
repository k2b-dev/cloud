### Terminal notice rows keep no transition spacer

- **What happened:** A historical version receipt exceeded its compact-height guard in WebKit.
- **Root cause:** A phone `NoticeRow` with `reserve={false}` and a stable action still used the four-track transition grid, including an empty 8 px track and an extra 2 px gap.
- **Error class:** Disabling a layout reserve leaves its empty grid tracks in place.
- **Guard:** The shared surface render test pins both grid forms. The version-card browser test checks compact receipt height and unchanged geometry when the controller takes over. Reserved loading and decision states retain their existing layout.
