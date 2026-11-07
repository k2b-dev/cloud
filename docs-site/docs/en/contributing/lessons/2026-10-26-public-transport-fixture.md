### The example fixture called a framework-specific router helper

- **What happened:** The example integration fixture called `request()` on a transport that exposes `fetch(Request)`.
- **Root cause:** The fixture assumed a framework-specific helper instead of the public transport contract.
- **Error class:** A fixture assumes a framework-specific router helper.
- **Guard:** The App-PWA example flow uses the public transport; its explicit test TypeScript project checks fixture calls as well as application code.
