### Bounded reader work must follow message order

- **What happened:** A changes page with more than sixty item threads could return no messages despite readable siblings.
- **Root cause:** PostgreSQL returned thread rows in an unspecified order. Reader work exhausted its budget before authorizing the first message in the requested page.
- **Error class:** Unordered authorization work before prefix pagination.
- **Guard:** Generic discussion integration tests cover cold pages across more than sixty threads. Thread checks now follow the candidate message order, reversed when reading backward.
