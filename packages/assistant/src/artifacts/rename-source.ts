import ts from "typescript";
import { ArtifactPath, ArtifactSource } from "./contracts";
import { resolveSourceImport } from "./runtime/compile";

/** Rewrite parsed module specifiers, never comments or ordinary string values. */
export function renameSource(input: unknown, from: string, to: string) {
  const source = ArtifactSource.parse(input);
  ArtifactPath.parse(from);
  ArtifactPath.parse(to);
  if (from === to) return source;
  if (!source.files.some((file) => file.path === from) || source.files.some((file) => file.path === to))
    throw new Error("Invalid rename target");
  const files = source.files.map((file) => {
    const nextPath = file.path === from ? to : file.path;
    if (!/\.(js|ts)$/.test(file.path)) return { ...file, path: nextPath };
    const tree = ts.createSourceFile(
      file.path,
      file.content,
      ts.ScriptTarget.Latest,
      true,
      file.path.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS,
    );
    const syntax = ts.transpileModule(file.content, {
      fileName: file.path,
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
    }).diagnostics;
    if (syntax?.some((d) => d.category === ts.DiagnosticCategory.Error)) throw new Error(`Fix syntax before renaming: ${file.path}`);
    const edits: { start: number; end: number; text: string }[] = [];
    function visit(node: ts.Node) {
      const spec =
        ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
          ? node.moduleSpecifier
          : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
            ? node.arguments[0]
            : undefined;
      if (spec && ts.isStringLiteralLike(spec) && (spec.text.startsWith("./") || spec.text.startsWith("../"))) {
        const target = resolveSourceImport(file.path, spec.text),
          nextTarget = target === from ? to : target;
        if (nextPath !== file.path || target !== nextTarget) {
          const base = nextPath.split("/").slice(0, -1),
            dest = nextTarget.split("/");
          while (base.length && dest.length && base[0] === dest[0]) {
            base.shift();
            dest.shift();
          }
          const relative = "../".repeat(base.length) + dest.join("/");
          edits.push({
            start: spec.getStart(tree),
            end: spec.end,
            text: JSON.stringify(relative.startsWith("../") ? relative : "./" + relative),
          });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
    let content = file.content;
    for (const edit of edits.sort((a, b) => b.start - a.start))
      content = content.slice(0, edit.start) + edit.text + content.slice(edit.end);
    return { path: nextPath, content };
  });
  return ArtifactSource.parse({ entry: source.entry === from ? to : source.entry, files });
}
