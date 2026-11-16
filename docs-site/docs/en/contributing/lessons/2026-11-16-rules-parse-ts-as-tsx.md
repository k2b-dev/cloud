### Repository rules stopped reading .ts files at a generic arrow

- **What happened:** Seventeen rules under `scripts/checks/` parsed every file as TSX. In 80 `.ts` files a generic arrow function such as `<T>(value: T) => …` read as a JSX tag, the parse broke there, and the rules never saw the rest of the file. `conflict-sentences` (#3576) missed most of its findings the same way.
- **Root cause:** Each rule called `ts.createSourceFile` with a fixed `ts.ScriptKind.TSX`, and TypeScript does not throw on a syntax error, so a rule visited a half tree without noticing.
- **Error class:** A parser told the wrong grammar, and parse errors swallowed so that a rule checked less than it claimed.
- **Guard:** `parseSource` in `scripts/checks/files.ts` picks the grammar by extension and returns a finding for a file that does not parse. `files.test.ts` parses a `.ts` sample with a generic arrow and finds the call after it, reports a broken file, and fails when a rule hard-codes `ts.ScriptKind.TSX` again. Making parse errors visible also exposed two invalid TSX samples in `host-breakpoints.test.ts` and `notice-cards.test.ts`.
