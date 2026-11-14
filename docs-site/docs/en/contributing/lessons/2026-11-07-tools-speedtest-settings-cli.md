### Wire administrator settings through the owning API

- **What happened:** Speedtest settings were available to the page but had no owning administrator API in the CLI mapping. CI also caught missing Help metadata and a platform selection fill in shared application CSS.
- **Root cause:** Local verification omitted the affected repository rules while shared check slots were occupied.
- **Error class:** A declared setting lacks a complete operator write path; shared presentation moves without preserving its repository contracts.
- **Guard:** Administrator authorization and CLI routing tests cover both settings, audit attribution, namespace isolation and validation. The OAuth integration guard includes the new setter. Run `admin-cli-settings`, `help-writing` and `selection-tokens` individually with `--apps` before handing off a stacked Tools slice.
