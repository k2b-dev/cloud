### Pulse query parameter budgets

- **What happened:** Retiring a large series batch exceeded ClickHouse's default 1 MiB URI limit and stalled retention.
- **Root cause:** The client encoded parameters in the URL without a size guard, while callers used the database scan size as the HTTP request size.
- **Error class:** Query parameters exceed the transport budget.
- **Guard:** Pulse's encoded URL budget unit test and multi-chunk retirement and late-sample successor integration tests.
