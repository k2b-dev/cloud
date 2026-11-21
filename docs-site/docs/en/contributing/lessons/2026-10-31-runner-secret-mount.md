### Image smoke tests must use the operator secret mount path

- **What happened:** The runner image smoke exited before acquiring work because its key file failed the supervisor ownership and exact `0400` check.
- **Root cause:** The smoke assumed its write call established `0400`; local Compose secrets also preserve host file metadata rather than reliably applying a container UID/mode. The shipped path relied on manual host ownership changes.
- **Error class:** Container startup assumes secret-provider metadata that its deployment contract does not guarantee.
- **Guard:** The default image entrypoint stages a mounted key in a private supervisor-owned `0400` file, then drops its startup-only read capability. The smoke uses the same mount and entrypoint as Compose. Native tests check file modes, source and copy isolation, capability removal across exec, and refusal of exposed sources. The strict supervisor check remains unchanged.
