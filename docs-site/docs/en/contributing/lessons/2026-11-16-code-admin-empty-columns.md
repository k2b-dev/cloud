### Code administration opened on two empty columns

- **What happened:** `/admin/code` without a section showed two empty columns that only repeated "Code · Everything that runs as Code in Cloud". In the approvals list, "Version 2" broke into two lines next to a long title.
- **Root cause:** The view fell back to a hint in both the section and the detail column when no section was chosen, instead of opening a section. The approval title was a flex row in which the version was a shrinkable item without `white-space: nowrap`.
- **Error class:** A master-detail area without a defined first view, and a short label that wraps as a flex item beside long text.
- **Guard:** `packages/core/src/pages/admin/code/CodeArea.render.test.tsx` renders the area without a section and counts its panes; `CodeArea.browser.test.ts` measures every version label as one line at 1440 and 390 px with a long title.
