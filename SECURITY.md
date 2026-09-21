# Security policy

## Report a vulnerability

Report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/k2b-dev/cloud/security/advisories/new).
Do not open a public issue or pull request for a security problem.

Include the affected component, a reproduction, and the impact you observed.
A report is acknowledged within five working days. Fixes ship as a patch
release with a changelog entry and, where relevant, a published advisory.

## Supported versions

The latest `cloud-v` minor release receives security fixes. Older minors are
not patched; upgrade to the current release.

Deployments pin `vX.Y.Z` image tags or digests from the release's
`release.json`. `sha-*` tags are main-branch builds without a support
commitment.
