### Domain cursors do not replace the capability page envelope

- **What happened:** Generic Code pagination loops stopped after the first Files or Spaces page. The same omission affected Notebooks, Core and Gateway Ops list adapters, plus terminal Grids GQL diagnostics.
- **Root cause:** Queries returned continuation cursors in domain data but omitted the shared `page` envelope that generated SDK consumers follow.
- **Error class:** Pagination metadata lost at an application transport boundary.
- **Guard:** `sdk-contract.test.ts` verifies that `validateCapabilityResult` rejects a Query with a string `cursor` input if `page` is missing, and verifies that a declared string `next` or `nextCursor` agrees with `page`. Date filters named `after` do not imply pagination. Application tests cover continuation and final pages. Domain cursor fields remain available to existing consumers.
