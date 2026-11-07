### Promise matchers leave lazy SQL queries unstarted

- **What happened:** Integration tests passed a SQL query directly to a rejection matcher and hung until the test timeout instead of checking the database constraint.
- **Root cause:** Bun SQL tagged queries are lazy. Passing a query to `expect(...).rejects` does not start it; `.execute()` or awaiting it inside an async expectation function starts the query.
- **Error class:** A promise assertion observes a lazy operation without starting it.
- **Guard:** The `lazy-sql-assertions` repository check rejects `expect(sql` or `expect(tx` tagged queries followed by `.rejects` or `.resolves`, including simple variable aliases within the same statement. Its fixture tests distinguish lazy queries from executed queries, awaited queries, and async expectation functions.
