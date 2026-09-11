import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const root = new URL("../../", import.meta.url).pathname;
const contextRoot = join(root, "docs-site/src/ui/context");
const filesIn = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesIn(join(directory, entry.name)) : [join(directory, entry.name)],
  );
const pages = filesIn(contextRoot).filter((file) => file.endsWith(".md"));
const config = ts.readConfigFile(join(root, "packages/ui/tsconfig.json"), ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, join(root, "packages/ui"));
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();
const entry = program.getSourceFile(join(root, "packages/ui/src/index.ts"));
if (!entry) throw new Error("UI public entry point is missing");
const moduleSymbol = checker.getSymbolAtLocation(entry);
if (!moduleSymbol) throw new Error("UI public exports are missing");
const publicNames = new Set(checker.getExportsOfModule(moduleSymbol).map((symbol) => symbol.name));

test("Markdown examples import existing public UI exports, including type imports and aliases", () => {
  const failures: string[] = [];
  for (const file of pages) {
    for (const [, code] of readFileSync(file, "utf8").matchAll(/```(?:tsx?|jsx?)[^\n]*\n([\s\S]*?)```/g)) {
      const source = ts.createSourceFile(file, code!, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
          statement.moduleSpecifier.text !== "@k2b/ui") continue;
        const bindings = statement.importClause?.namedBindings;
        if (statement.importClause?.name) failures.push(`${file}: unsupported default UI import`);
        if (!bindings || !ts.isNamedImports(bindings)) continue;
        for (const element of bindings.elements) {
          const name = (element.propertyName ?? element.name).text;
          if (!publicNames.has(name)) failures.push(`${file}: unknown UI export ${name}`);
        }
      }
    }
  }
  expect(failures).toEqual([]);
});

test("standalone Markdown examples typecheck against the current UI contract", () => {
  const examples = new Map<string, string>();
  for (const file of pages) {
    let index = 0;
    for (const [, code] of readFileSync(file, "utf8").matchAll(/```tsx typecheck\n([\s\S]*?)```/g)) {
      examples.set(join(root, `packages/ui/.docs-example-${examples.size}.tsx`),
        `// ${file} example ${++index}\n${code}`);
    }
  }
  expect(examples.size).toBeGreaterThanOrEqual(4);
  const options = { ...parsed.options, noEmit: true, noUnusedLocals: false, noUnusedParameters: false,
    paths: { ...parsed.options.paths, "@k2b/ui": [join(root, "packages/ui/src/index.ts")] } };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => {
    const code = examples.get(file);
    return code === undefined ? getSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile)
      : ts.createSourceFile(file, code, languageVersion, true, ts.ScriptKind.TSX);
  };
  const exampleProgram = ts.createProgram([...examples.keys()], options, host);
  const failures = ts.getPreEmitDiagnostics(exampleProgram)
    .filter((diagnostic) => diagnostic.file && examples.has(diagnostic.file.fileName))
    .map((diagnostic) => `${diagnostic.file?.text.split("\n")[0]}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
  expect(failures).toEqual([]);
}, 30_000);
