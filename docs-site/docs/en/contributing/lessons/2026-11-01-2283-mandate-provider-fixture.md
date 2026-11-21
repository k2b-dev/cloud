### A provider fixture put HTTP status into its error body

- **What happened:** Two mandate integration cases expected a resource denial but received an invalid provider response instead.
- **Root cause:** The fixture serialized the internal error directly, including `status`, although the strict wire schema carries status only in HTTP metadata.
- **Error class:** A transport fixture duplicates serialization and drifts from the production contract.
- **Guard:** The mandate integration fixture uses `serializeCapabilityProviderResult`, as production providers do. Both denial cases assert the provider error code and message as well as the HTTP status and absence of an effect.
