### Studio authority helpers imported their service back

- **What happened:** The Studio machine-execution change failed the `cycles` check: a service called an authority helper that imported the service's error class and grant validation back.
- **Root cause:** Shared identity and error types lived in the service module instead of a leaf module, so the authority helper and the service imported each other at runtime.
- **Error class:** Domain services import each other at runtime.
- **Guard:** Check: `cycles`. Convention: keep shared identity and errors in a leaf module and grant validation in the authority module.
