### A shared credential cap erases a broker contract

- **What happened:** Applying the Project and private Skill credential cap to app Skills rejected authorized app-scoped and resource-bound reads.
- **Root cause:** The shared credential cap omitted the app Skill broker contract, which authorizes reads through app access and Skill grants.
- **Error class:** A shared credential cap erases a broker contract.
- **Guard:** `skills-app-access.integration.test.ts` and `tests/app-access-skills-mount.integration.test.ts` require app access plus Skill grants, preserve read-only broker permissions, and reject private resources, cross-app reads, missing grants, and machine HTTP management.
