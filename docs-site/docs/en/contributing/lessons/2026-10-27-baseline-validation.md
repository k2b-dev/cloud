### Keep baseline validation independent of optional constraints

- **What happened:** Equivalent call shapes produced different validation outcomes.
- **Root cause:** Shared validation ran only while evaluating optional constraints.
- **Error class:** Conditional baseline validation.
- **Guard:** Table-driven mandate policy tests cover optional constraints, action modes, live metadata, and discovery. The self-service and broker integration test checks creation, confirmation, and dispatch together.
