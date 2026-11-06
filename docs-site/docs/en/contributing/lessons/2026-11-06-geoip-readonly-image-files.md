### Bundled databases must open without filesystem write access

- **What happened:** Core lost country, sign-in location, and network lookups when its container used a read-only root filesystem.
- **Root cause:** Bun 1.4.4 opens `Bun.mmap` paths read-write, including private mappings. Giving the runtime user ownership did not make the files writable on a read-only filesystem.
- **Error class:** Reading an image asset accidentally requires runtime write access.
- **Guard:** The GeoIP test opens read-only City and ASN fixtures and checks status, country, sign-in lookups, replacement, and reset. The CI image smoke boots Core with `--read-only` and requires both bundled databases through the authenticated GeoIP status API.
