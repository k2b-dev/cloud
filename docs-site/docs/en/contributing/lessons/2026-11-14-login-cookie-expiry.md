### A zero-age cookie survived until the next millisecond in DOM tests

- **What happened:** A completed Cloud Login sign-in sometimes left `login_email=` in the DOM test's cookie header, so the account-type regression failed in the merge queue.
- **Root cause:** Happy DOM 20.14.5 converted `max-age=0` into the current timestamp but expired cookies only when their deadline was strictly less than `Date.now()`. A synchronous read at the same timestamp therefore returned a deleted cookie. The application correctly used the shared cookie deletion API.
- **Error class:** A simulated browser treats an expiry deadline as inclusive and disagrees with real browser cookie deletion.
- **Guard:** `packages/ui/test/dom-cookies.behavior.test.ts` freezes the clock and checks immediate deletion of present and absent cookies, exact expiry deadlines, and preservation of future and session cookies. A Bun dependency patch corrects the comparison in Happy DOM; the existing Core app-approval behavior tests keep checking account-type restoration.
