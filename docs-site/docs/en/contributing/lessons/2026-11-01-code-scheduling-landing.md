### Exercise the scheduler against the broker before landing

- **What happened:** The scheduling integration fixture could not provision its one-minute queue, and new runner settings lacked administration CLI mappings.
- **Root cause:** The queue inherited a two-minute deduplication window, which exceeded its retention; the new settings were missing from the owning setter map.
- **Error class:** Integration configuration and repository contract drift across a stack merge.
- **Guard:** Keep the fixture deduplication window within retention, run the bounded scheduling integration file including three runners and 200 runs, and run `admin-cli-settings` for new settings. Check merged scheduling schemas with typecheck and the lost-line comparison.
