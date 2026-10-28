### Certification includes browser prerequisites and current request contracts

- **What happened:** Nightly Grids certification could not launch Chromium, and the Studio settings test rejected the empty unreadable-setting replacement list.
- **Root cause:** The certification job omitted browser installation; the settings fixture expected the older request shape.
- **Error class:** A CI job runs a suite without the prerequisites or request contract that suite needs today.
- **Guard:** `nightly-grids-reports.test.ts` requires Chromium installation before certification. The Studio administration browser test checks the complete preview request, including `replaceUnreadable: []`, while retaining its no-save assertion.
