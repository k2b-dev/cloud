### Preserve existing callers when adding SDK types

- **What happened:** SDK polish exceeded the chat tool's declaration budget and rejected existing AI result checks.
- **Root cause:** Repeated schema projections and long JSDoc expanded declarations; a generic AI signature replaced the broad result signature and narrowed valid legacy branches to `never`.
- **Error class:** An additive public type change breaks an existing consumer's constraints.
- **Guard:** The unchanged chat SDK budget test measures the index plus any two apps. The checker retains the scheduled summary scenario; focused regressions cover legacy JSON and decision narrowing, explicit precise typing, conservative broad required lists, shared schema declarations, and stable diagnostic names across selected app catalogs.
