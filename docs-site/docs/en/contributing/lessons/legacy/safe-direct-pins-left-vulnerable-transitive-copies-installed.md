### Safe direct pins left vulnerable transitive copies installed

- **What happened:** The dependency audit reported two critical and seven high advisories even though the direct MCP SDK and Seroval pins were already outside their affected ranges.
- **Root cause:** Fibel pinned an older SDK, Solid restricted its nested Seroval to the 1.5 series, Sharp was pinned to 0.35.4, and older range-compatible Proxy-Addr and Source-Map-JS versions remained locked.
- **Error class:** Checking direct dependency versions instead of every resolved copy and its upstream range.
- **Guard:** The existing nightly `bun audit --audit-level=high` checks the resolved graph. Verify upstream advisories and consumer paths before updating: Fibel still needs a supported SDK release, and the disputed cache advisory has no confirmed behavior fix in 4.3.0. Keep those findings visible rather than adding overrides or weakening the audit.
