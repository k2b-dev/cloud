### The access dialog merged a principal's grant and denial into one row

- **What happened:** Grids allows a principal to hold both a grant and a denial (`none`) on a base or an app. The shared access dialog keyed its rows by principal, so both rows showed the first entry and the denial could not be removed. A removed denial that restored a manager was saved after a lowered level, so Grids refused the lowering with "last manager" although the final state kept one. A stored public or signed-in denial showed as switched on. The public warning also promised read-only access for Grids Apps, whose visitors can send published forms. All of this was found in the sol review of the Grids migration before Grids used the dialog.
- **Root cause:** The draft model was built for apps with one entry per principal and without stored denials.
- **Error class:** A shared model keyed by a natural attribute (the principal) that some callers do not keep unique.
- **Guard:**
  - Rows now key by stored entry and by principal only for added rows.
  - `saveOrder` puts removed denials with the raised levels.
  - General switches treat `none` as off.
  - `publicWarning` lets a resource say what visitors can do.
  - `access-draft.test.ts` covers two rows for one principal and the denial-first handover; `AccessDialog.behavior.test.tsx` covers a stored public denial and the custom warning.
