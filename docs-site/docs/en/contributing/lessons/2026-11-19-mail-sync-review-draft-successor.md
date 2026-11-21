### Port merged regression tests to the current draft author

- **What happened:** The Mail typecheck failed after merging a self-reply regression test that imported a retired workflow helper.
- **Root cause:** The merge combined a new test from main with feat/code's removal of Mail workflows. The supported successor creates service-account suggestions through the shared draft service.
- **Error class:** A semantic merge retains a test for a retired entry point instead of covering its supported successor.
- **Guard:** The Mail typecheck rejects the missing export. The self-reply integration test now checks that a service-account suggestion can retain empty recipients for human review while sending still fails without a recipient.
