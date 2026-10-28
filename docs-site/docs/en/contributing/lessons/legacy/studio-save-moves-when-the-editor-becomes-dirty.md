### Studio Save moves when the editor becomes dirty

- **What happened:** In the Studio manual editor, the first edit inserted "Unsaved changes" before Save, and Save jumped sideways ([#1146](https://github.com/k2b-dev/cloud/issues/1146)).
- **Root cause:** The status text is mounted only while the editor is dirty, inside the same flex row as Save.
- **Error class:** Layout shift.
- **Guard:** Pending in [#1146](https://github.com/k2b-dev/cloud/issues/1146). The class rule is [Keep the layout still](/en/docs/frontend/styling-and-accessibility#keep-the-layout-still).
