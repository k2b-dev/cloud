### Validate retry metadata at every transport boundary

- **What happened:** Browser and native uploads accepted `Retry-After: Infinity`, which could leave a consumer waiting indefinitely.
- **Root cause:** The upload transports checked positivity while the HTTP transport also checked finiteness.
- **Error class:** Untrusted numeric metadata escapes a transport without a finite bound.
- **Guard:** All three transports accept only finite positive retry seconds. Transport tests cover infinite and overflowing values, malformed or absent headers, non-positive values, and a valid countdown.
