### Resize cues and reset behavior differed between columns

- **What happened:** Mail's conversation pane showed a soft drag shadow, while its Detail column showed none; sidebar, drawer, and standalone separators lacked the same reset behavior.
- **Root cause:** Detail omitted the shared shadow flag, standalone separators had separate cue styles, and reset handlers covered only panes and details.
- **Error class:** Shared interaction behavior implemented for only some consumers.
- **Guard:** `resize-cue.browser.test.ts` covers every workspace edge and standalone separator, including sequential arrow keys, cue geometry, reduced motion, and reset. Focused separator, workspace, and Cloud panel behavior tests cover callbacks and saved-size removal. Reactive workspace tests keep custom reset defaults after another region saves; RTL browser cases check the cue's side.
