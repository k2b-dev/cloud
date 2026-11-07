### Share measurement semantics across every consumer

- **What happened:** Browser, Cloud CLI and served scripts used different transfer loops, statistics and cancellation behavior. Moving scripts could also silently keep old public URLs alive.
- **Root cause:** Each presentation owned measurement logic rather than consuming one engine, and route declarations were separate from migration behavior.
- **Error class:** Consumer contract drift and unsafe migration boundaries.
- **Guard:** Tools browser flow tests exercise the shared engine through done, cancel, offline, error, retry, disabled and 429 while checking fixed slots. CLI tests reject leaked credentials and preserve retry delays; route tests require bounded no-store 410 responses without redirects. Public-access and OpenAPI tests cover the configuration and legacy routes.
