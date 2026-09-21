# Assistant browser sandbox

`chromium-seccomp.json` derives from the Apache-2.0-licensed
[Playwright Docker profile](https://github.com/microsoft/playwright/blob/v1.62.0/utils/docker/seccomp_profile.json).
It adds `chroot` to the unconditional syscall allowlist: Chromium needs it inside
its unprivileged user namespace even when the container drops all capabilities.
All other profile restrictions remain in place. See `PLAYWRIGHT-LICENSE`.

The development and production Compose configurations use this profile only for
Assistant. Runtime requirements and the isolation boundary are documented in
[deployment requirements](../docs-site/docs/en/operations/deployment-requirements.md#assistant-chromium-sandbox).
