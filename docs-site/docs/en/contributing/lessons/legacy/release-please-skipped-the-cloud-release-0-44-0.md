### release-please skipped the Cloud release 0.44.0

- **What happened:** Merging release PR #1248 created the npm releases but no `cloud-v0.44.0`; images and CLI assets needed a manual recovery ([#1298](https://github.com/k2b-dev/cloud/issues/1298)).
- **Root cause:** A BREAKING CHANGE footer contained `<dir>`-style text. release-please parses the release PR body as HTML, so the unclosed tag swallowed the Cloud section.
- **Error class:** Release notes parsed as HTML.
- **Guard:** The `release-body` CI job parses each release PR body with the pinned release-please parser, on the PR and in the merge queue. Its self-test fails on the #1248 body as merged. The `check` job refuses such markup in PR titles and release text in PR bodies. [Release process](/en/docs/contributing/release-process#recover-a-release-that-release-please-skipped) records the recovery.
