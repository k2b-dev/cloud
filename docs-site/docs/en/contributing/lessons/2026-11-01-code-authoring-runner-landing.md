### Stage compiler dependencies outside the workspace links

- **What happened:** The runner image failed while copying its checker libraries, before the compiled tests could run.
- **Root cause:** Bun had already linked the destination package to the source package. A recursive copy followed that link back into the source instead of creating an independent runtime directory.
- **Error class:** Image packaging through dependency-manager symlinks, compounded by container launch settings drifting between test paths.
- **Guard:** Stage runtime libraries in a fresh directory outside workspace `node_modules`, then copy that directory into the final image. Keep the image and runner attack gates on the same init, AppArmor and seccomp settings, including containers started by test fixtures. Run the existing real checker/test-role image tests and the bounded Core scheduling integration file before landing.
