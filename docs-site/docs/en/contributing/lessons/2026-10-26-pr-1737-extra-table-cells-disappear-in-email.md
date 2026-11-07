### Extra table cells disappear in email

- **What happened:** The editor shows every cell, but GFM email rendering truncates rows to the header width.
- **Root cause:** Extra table cells disappear in email.
- **Error class:** Extra table cells disappear in email
- **Guard:** Test: Mail `compose-table-check.test.ts` requires the preview/send renderer to reject extra cells, including signatures, and accept a corrected table without losing its text. Plain text and fenced code stay unchanged.
