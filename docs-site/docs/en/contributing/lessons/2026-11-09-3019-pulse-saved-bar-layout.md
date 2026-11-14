### New chart layouts must be opt-in for saved panels

- **What happened:** Saved Pulse bars with a series column or multiple values changed to grouped charts. Repeated category/series pairs became panel errors after the upgrade.
- **Root cause:** The adapter and view chose a new aligned layout from the SQL columns instead of an explicit new panel kind. The saved parity fixtures covered only single-value bars.
- **Error class:** An additive feature changes the interpretation of previously valid saved data.
- **Guard:** `dashboard-saved-parity.test.ts` checks strict SVG hashes captured from main for saved series, multiple-value and duplicate-pair bars. `Dashboard.browser.test.ts` checks their flattened marks and keyboard labels through the actual panel view on desktop and phone. Aligned layouts require explicit new kinds.
