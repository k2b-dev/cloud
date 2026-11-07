### Keep configuration discovery and generic settings writes aligned with their callers

- **What happened:** Mail rejected compatible contact-directory applications during configuration. The general settings command could show a declared application setting but rejected a write to it.
- **Root cause:** Mail omitted the acting request authority from catalog reads. The generic application setter also required environment migration metadata for ordinary settings. Mail’s general CLI setting writes now use the same application setter as its contact-directory form.
- **Error class:** Dropped request context and an obsolete eligibility filter on a shared administration path.
- **Guard:** Mail contact-directory service tests exercise real catalog filtering, and the focused integration test configures a provider before invoking suggest and resolve as a sender. The signed settings-route test covers settings without environment metadata, undeclared keys, application-owned write paths, and read-only credentials. Route and service tests preserve authority object identity. The application-settings route test covers the existing settings that require their owning setters.
