### Stub the server check in every test that submits a Code version

- **What happened:** The Code secrets integration test failed on every open pull request as soon as Code versions were checked on the runners, with "The Code capability catalog is unavailable."
- **Root cause:** Slice C13b made `submitCodeVersion` run the binding server check. It landed right after the secrets slice, so neither gate ran the combination, and the secrets test had no stub for that check.
- **Error class:** Two slices landing in parallel on an integration branch, each green alone, break a test only in combination.
- **Guard:** The secrets test now stubs `verifyCodeSubmission` like the versions test. Landing merges `feat/code` and runs the affected single files, which would catch this only if the second slice lands after the first is on the branch; the integration acceptance suite (C25) covers the real check.
