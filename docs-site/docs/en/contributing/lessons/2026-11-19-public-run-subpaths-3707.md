### Public subpaths need consumer resolution and compile fixtures

- **What happened:** The run-ledger API passed Core's local typecheck but failed the Runner typecheck and documentation import coverage in CI.
- **Root cause:** The new contract subpath matched only an extensionless package-export wildcard. Core's source-path aliases hid the missing TypeScript package resolution, while Runner consumed the package export. The documented browser helper also had no compile fixture.
- **Error class:** Public entry points checked only through source aliases.
- **Guard:** The explicit `@k2b/cloud/contracts/code-runs` export names its `.ts` target. Runner's typecheck exercises package resolution without Core's aliases. The `code-run-ledger.tsx` documentation fixture compiles the browser helper, contract leaf and focused RunLog entry; `check:example-coverage` rejects documented imports without fixtures.
