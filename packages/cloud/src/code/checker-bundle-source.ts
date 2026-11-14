import ts from "@typescript/typescript6";
import { type CodeVersionManifest, CodeVersionManifestSchema } from "./checker-contract";

/** Entry names are ESM string exports (routes and event names included), never source fragments. */
export function codeCheckHostSource(entries: CodeVersionManifest["entrypoints"], codeRun: boolean): string {
  const entrypoints = CodeVersionManifestSchema.shape.entrypoints.parse(entries);
  const expected = JSON.stringify(
    [...entrypoints]
      .sort((a, b) => a.entrypoint.localeCompare(b.entrypoint))
      .filter((e) => e.kind !== "manual")
      .map(({ kind, entrypoint, cron, at, timeZone, title, route, event }) => ({
        kind,
        entrypoint,
        ...(route ? { route } : {}),
        cron,
        ...(at === undefined ? {} : { at }),
        ...(timeZone === undefined ? {} : { timeZone }),
        ...(event === undefined ? {} : { event }),
        ...(title === undefined ? {} : { title }),
      })),
  );
  const source = ts.createSourceFile(
    "host.js",
    `
import { __codeSdk } from "@sdk";
function createRun(entrypoint) {
  return async function(input, cloud) {
    __codeSdk.bind(cloud);
    const user = await import("code:entry");
    if (JSON.stringify(__codeSdk.entries().sort((a,b) => a.entrypoint.localeCompare(b.entrypoint))) !== expected)
      throw new Error("code_entrypoints_changed");
    ${codeRun ? "return user.default(input);" : "return __codeSdk.run(entrypoint, input);"}
  };
}
`,
    ts.ScriptTarget.ESNext,
    false,
    ts.ScriptKind.JS,
  );
  const f = ts.factory;
  const constant = (name: string, value: ts.Expression) =>
    f.createVariableStatement(
      undefined,
      f.createVariableDeclarationList([f.createVariableDeclaration(name, undefined, undefined, value)], ts.NodeFlags.Const),
    );
  const statements: ts.Statement[] = [...source.statements, constant("expected", f.createStringLiteral(expected))];
  for (const [index, entry] of entrypoints.entries()) {
    const name = f.createIdentifier(`run${index}`);
    statements.push(
      constant(name.text, f.createCallExpression(f.createIdentifier("createRun"), undefined, [f.createStringLiteral(entry.entrypoint)])),
      f.createExportDeclaration(
        undefined,
        false,
        f.createNamedExports([f.createExportSpecifier(false, name, f.createStringLiteral(entry.entrypoint))]),
      ),
    );
  }
  return ts.createPrinter().printFile(f.updateSourceFile(source, statements));
}
