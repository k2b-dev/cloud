### Local archive snapshots lose their location

- **What happened:** An administrator's local archive event disappears because its recorded path lies outside the binding's former home.
- **Root cause:** A current home prefix is applied to historical archive locations.
- **Error class:** A current home prefix is applied to historical archive locations.
- **Guard:** Files `service/activity-reader.test.ts` and `service/activity-reader.integration.test.ts` preserve administrator snapshots for archived local bindings while ordinary readers require a current active grant.
