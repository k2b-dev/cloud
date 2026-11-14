### Carry opt-in chart behavior into the new shared adapter

- **What happened:** Merging the shared description adapter replaced the showcase path that connected detailed line charts to cursor legend values.
- **Root cause:** The new panel supplied a custom chart child and rows to ChartExplorer, so its external legend could not inspect the prepared snapshot.
- **Error class:** Moving a consumer to a shared adapter loses optional behavior carried by the old integration.
- **Guard:** Detailed lines pass their prepared snapshot through ChartExplorer in the shared panel. A server-rendering test checks the marker’s resting value in ready and stale states and keeps ordinary line legends unchanged. Existing snapshot, browser and parity guards remain strict.

The broader showcase import graph also exposed an ambient UI test declaration that hid real `@babel/core` exports. The fixtures now use Babel’s own declarations and type only the undeclared presets; the UI DOM typecheck guards this integration.
