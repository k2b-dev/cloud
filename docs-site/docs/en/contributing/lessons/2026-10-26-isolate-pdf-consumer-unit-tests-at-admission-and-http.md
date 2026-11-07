### Isolate PDF consumer unit tests at admission and HTTP

- **What happened:** The query-export starter escaping test failed before its mocked renderer request.
- **Root cause:** Shared PDF rendering requires downstream admission; this consumer unit test mocked HTTP but omitted the existing admission fixture.
- **Error class:** A unit test accidentally depends on shared infrastructure.
- **Guard:** The starter test uses the scoped PDF admission mock, asserts one admission attempt, and retains the actual template-rendering and escaping assertions. Platform and integration tests continue to exercise real admission.
