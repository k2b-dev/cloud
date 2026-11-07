### Zoned recurring schedules must survive the bundle registration fence

- **What happened:** A checked recurring schedule with a time zone failed to start with `code_entrypoints_changed`, including when the same version also declared events or routes.
- **Root cause:** The bundle worker copied `timeZone` only with a one-time `at` field. The checked manifest and SDK runtime also carried it for cron schedules, so their registration descriptors differed.
- **Error class:** A new field is preserved by analysis and runtime but lost by an intermediate contract projection.
- **Guard:** The checker bundle test executes route, event, one-time and zoned recurring entrypoints from one checked version through the actual registration fence.
