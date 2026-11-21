### Keep declared call scope and live authorization together

- **What happened:** Code admission needed one consistent runtime boundary for declared operations, targets and refs.
- **Root cause:** Declared scope and current authorization are separate constraints; both must hold for the actual call.
- **Error class:** Incomplete enforcement of a declared execution scope.
- **Guard:** The capability-set runtime regressions, signed bridge regressions and chat runner host tests check admission before dispatch while preserving current access and approval checks.
