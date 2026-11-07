### Pulse pages rendered without the Pulse stylesheet

- **What happened:** Every Pulse page linked `/public/pulse/app.css`, but the gateway answered it with 404, so overview, SQL console and settings showed unstyled text.
- **Root cause:** A September change removed `/public/pulse` from the Pulse routes; the platform still links the stylesheet and favicon below that prefix. Browser harnesses load the stylesheet directly, so no test noticed.
- **Error class:** An app links assets below a prefix it never declared to the gateway.
- **Guard:** The `app-public-route` check requires the app's own `/public/<id>` prefix in every app config that declares pages below `/app/` or `/admin/`.
