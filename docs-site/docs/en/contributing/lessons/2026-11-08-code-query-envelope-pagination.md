### Code queries lost the cursor outside their domain data

- **What happened:** Code authors could read only the first page of paginated capability Queries.
- **Root cause:** The runner bridge and one-off SDK adapter unwrapped only domain data, dropping the capability envelope's `page`; generated Query signatures described only domain data too.
- **Error class:** Transport projections discard pagination metadata required to continue a bounded query.
- **Guard:** Generated SDK type and snapshot tests require `CodeQueryResult<T>`; runner-bridge tests collect every item exactly once across three pages with the returned cursors and reject an unbounded walk at the call limit. The documented bounded loop is checked against a third-party manifest.
- **Fixture fidelity:** Compile pagination fixtures through the manifest compiler so schemas and their hashes stay together. Mutating only `inputSchema` can reuse a cached validator and fail on a cursor before reaching the call limit. Integration coverage checks both the current settings limit and the run's stored limit, including the durable call records. Measure provider-call deltas when the fixture counter spans tests.
