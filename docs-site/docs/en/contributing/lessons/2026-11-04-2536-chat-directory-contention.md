### A grant success test raced the directory contention guard

- **What happened:** PR #2536's Chat integration job received 409 instead of 200 when adding a group and a person after the large group fixture. The full file passed locally.
- **Root cause:** The happy-path test did not exclude concurrent directory locks. The CI PostgreSQL log confirms SQLSTATE `55P03` on `auth.user_groups_v2`; A1 deliberately turns that conflict into a retryable 409 before changing grants. The holder was not captured, so background maintenance remains a possible explanation rather than a confirmed cause.
- **Error class:** Uncontrolled database lock contention in a test that expects immediate mutation success.
- **Guard:** The affected Chat success case holds compatible directory locks around its request, acquired before any identity or target locks with a five-second lock timeout. A separate integration case holds a conflicting directory lock and asserts the retryable 409, unchanged Chat state, and successful mixed addition after commit. Its barrier stays local to the reproducing file; contention guards and production lock semantics remain unchanged.
