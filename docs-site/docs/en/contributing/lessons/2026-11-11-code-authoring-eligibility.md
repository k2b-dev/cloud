### Keep authoring eligibility consistent across transports

- **What happened:** Authoring entry points did not share the same eligibility rule.
- **Root cause:** The common author check covered credentials and ownership but omitted the account profile.
- **Error class:** Inconsistent authoring eligibility across transports.
- **Guard:** Store, HTTP, CLI and chat-tool regression tests cover the shared refusal; integration tests retain member success and verify current-profile tool discovery and Skill loading.
