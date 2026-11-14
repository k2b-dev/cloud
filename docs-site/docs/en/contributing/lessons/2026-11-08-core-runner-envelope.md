### Exercise Runner operations through the Core application envelope

- **What happened:** A chat job operation did not reach the same protocol handler through the deployed application as it did through a bare router.
- **Root cause:** The application route declaration and the complete Runner protocol path set had drifted.
- **Error class:** Route registration drift across framework and domain boundaries.
- **Guard:** Runner envelope tests cover every declared protocol path and exercise a chat job request through the Core entry middleware and real router, including success and refused route authentication.
