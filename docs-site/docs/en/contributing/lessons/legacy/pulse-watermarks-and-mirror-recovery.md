### Pulse watermarks and mirror recovery

- **What happened:** Partial writes left incorrect counter increases; expired series stayed visible; recreated databases lost their source listings.
- **Root cause:** The watermark committed after external inserts, retention deleted only the registry, and schema rebuilds retained mirror acknowledgements. A database creation surviving a rollback also let the old schema ledger skip the rebuild.
- **Error class:** Lost evidence of an external write; registry and mirror divergence; stale mirror acknowledgements.
- **Guard:** Pulse's partial-counter rollup, series tombstone and budget, and missing-database mirror recovery integration tests reproduce each failure before its fix.
