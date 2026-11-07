### Framework-free chart inspection needs a pure message catalogue

- **What happened:** Area tooltip localization pulled Solid into the published framework-free chart inspection entry.
- **Root cause:** The inspector imported a message module that also imported the Solid locale hook, so its JavaScript and declaration graphs reached Solid.
- **Error class:** Framework dependencies leaking across a portable package boundary.
- **Guard:** The published JavaScript and declaration import-graph test in `packages/ui/src/chart-inspection.test.ts` rejects Solid dependencies. Its localization fixture now imports the pure catalogue directly; the Solid hook composes that same catalogue.
