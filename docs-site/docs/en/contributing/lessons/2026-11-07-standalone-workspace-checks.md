### Classify standalone packages before applying Cloud application checks

- **What happened:** The standalone speedtest server failed configuration documentation and service facade checks even though it has no Cloud runtime dependency.
- **Root cause:** Both checks discovered Cloud applications by scanning package directories instead of using the workspace application list.
- **Error class:** Repository checks apply a domain contract to a package outside that domain.
- **Guard:** Configuration discovery and service facade checks use `appIds()` from the workspace owner. A configuration generator regression runs the real rule against the standalone package; a facade fixture verifies that an actual Cloud application still requires its facade while standalone packages do not.
