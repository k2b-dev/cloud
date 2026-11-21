### Keep decision refusals specific through every client

- **What happened:** A version review gave the same retry instruction for different refused decisions.
- **Root cause:** The version service collapsed platform refusal reasons into one forbidden response, and the review chose its message only from the HTTP status.
- **Error class:** Loss of domain failure meaning at transport boundaries.
- **Guard:** The Code version integration tests preserve each reason through the administration route and capability; the Code area browser tests cover recovery in both shipped locales and keep technical diagnostics out of product text.
