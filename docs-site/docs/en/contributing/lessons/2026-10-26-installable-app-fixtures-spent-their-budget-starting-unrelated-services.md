### Installable-app fixtures spent their budget starting unrelated services

- **What happened:** Focused App-PWA gateway tests timed out during development before reaching their assertions.
- **Root cause:** Child fixtures imported the complete platform service graph, and a compression fixture used Brotli's maximum quality although it only needed a valid compressed body.
- **Error class:** A focused fixture performs unrelated startup or expensive data preparation.
- **Guard:** Gateway fixtures provide the minimal configuration and audit modules required by the route; the Brotli fixture uses quality 4. The focused gateway tests retain their original timeout bounds and verify the response contents.

