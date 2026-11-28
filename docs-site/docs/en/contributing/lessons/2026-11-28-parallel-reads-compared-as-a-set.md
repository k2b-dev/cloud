### A statement test compared two parallel reads in a fixed order

- **What happened:** The Code administration test "each section's first view costs a fixed number of statements" failed on a pull request that did not touch Code. In CI the History section's count read came after its audit page read instead of before it (#4579).
- **Root cause:** `audit.list` reads the count and the rows of a page with `Promise.all`. The database receives the two statements in either order, but the test compared the History statements as an ordered list.
- **Error class:** A statement-metering test expects a fixed order for statements that the code under test starts concurrently.
- **Guard:** The test itself. It still pins the number of statements and the first statement (the area's counts), and keeps the name lookups that run one after another in order. Only the concurrent pair is compared as a set, so an extra statement per row still fails it. The other sections of the test read one statement after another and stay ordered.
