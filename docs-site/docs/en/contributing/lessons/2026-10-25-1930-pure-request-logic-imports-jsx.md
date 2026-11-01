### Pure request logic imports JSX

- **What happened:** A unit test or server caller loads the whole view and requires a JSX runtime even though it only needs filters and dates.
- **Root cause:** A pure request helper is owned by a component module.
- **Error class:** A pure request helper is owned by a component module.
- **Guard:** Shared activity request types, date ranges, and request construction live in `history-requests.ts`. The existing fixed-date `history-ranges.test.ts` exercises that module without importing a component. Evidence: Files package and integration runners both execute the range tests.
