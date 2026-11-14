### Resource sharing must include service accounts by default

- **What happened:** Most resource share dialogs could not add a service account by its handle.
- **Root cause:** Each application had to implement and pass its own lookup callback.
- **Error class:** A shared workflow depends on an application remembering optional wiring.
- **Guard:** `access-editor-targets` rejects resource editors without a target. Table-driven behavior coverage reads each application's target configuration and exercises the shared handle lookup and normal grant. Browser tests exercise the default transport at desktop and phone widths.
