### JSON Schema patterns must retain Unicode semantics

- **What happened:** Capability responses with ordinary letters in a title failed registry validation. The original Zod schema accepted the same data.
- **Root cause:** Zod 4.6.7 exports a regular expression's source, as JSON Schema requires, but its importer reconstructed `pattern` and `patternProperties` without Unicode mode. Property escapes then matched literal letters and surrogate pairs were split.
- **Error class:** A schema roundtrip changed validation semantics while remaining syntactically valid.
- **Guard:** A workspace dependency patch restores Unicode mode in all three importer sites and in its source, ESM and CommonJS forms. Tests prove nested string constraints, astral letters and format controls, and object-key matching. Provider compilation checks Unicode syntax without relying on the importer patch and reports an operation plus schema path. A discovery-based test transports every registered capability and event pattern through JSON and compares acceptance against native Unicode regular expressions using a fixed corpus. Keep the patch until an upstream version passes these guards without it.
