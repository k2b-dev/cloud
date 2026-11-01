### A normal administrator CLI login could not reach the UI's operational controls

- **What happened:** An administrator signed in with the default CLI scopes could not read NATS, Sync, app events or Pulse administration. Several UI settings had no CLI command.
- **Root cause:** Some read routers required the elevated OAuth scope, although the current administrator role already authorized their readers. Settings and CLI coverage were maintained separately.
- **Error class:** Authorization and administration coverage drift between browser and CLI transports.
- **Guard:** The admin authorization fixtures exercise ordinary scopes, live role revocation and roleless OAuth clients at the affected routers. CLI tests require confirmation and protected credential input. The `admin-cli-settings` repository rule requires a CLI setter for declared settings, including custom owner APIs. Sync payloads and raw errors stay redacted with ordinary read scopes. Unredacted content and recovery operations retain explicit step-up, tested separately.
