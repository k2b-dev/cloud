import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "@typescript/typescript6";
import type { Finding, Rule } from "./rule";

/**
 * A v2 primitive owns its spacing, lines, height and type (concept rule 2 and rule 4). A prop that hands one of them to
 * the app is a second way to lay out, so no component that `@k2b/ui/v2` exports accepts `class`, `className`,
 * `classList`, `style`, `size`, `gap`, `padding`, `density` or `appearance`; this holds for its dotted parts
 * (`Workspace.Main`) and for every member of a props union. The rule reads the prop types with the type checker, so
 * a prop inherited from `JSX.HTMLAttributes` or a spread type counts as well. `Canvas` is no exception: it may draw
 * freely inside, but takes its size from its place.
 */
const ENTRY = "packages/ui/src/v2/index.ts";
export const forbiddenProps = ["class", "className", "classList", "style", "size", "gap", "padding", "density", "appearance"] as const;

const options: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.Preserve,
  jsxImportSource: "solid-js",
  strict: true,
  skipLibCheck: true,
  noEmit: true,
  types: [],
};

/** Every forbidden prop of every component the entry exports, with the line of the component's declaration. */
export const forbiddenPrimitiveProps = (entry: string): { file: string; line: number; component: string; prop: string }[] => {
  const program = ts.createProgram([entry], options);
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  const module = source && checker.getSymbolAtLocation(source);
  if (!source || !module) return [];
  const found: { file: string; line: number; component: string; prop: string }[] = [];
  const where = (symbol: ts.Symbol) => {
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (!declaration) return { file: entry, line: 1 };
    const file = declaration.getSourceFile();
    return { file: file.fileName, line: file.getLineAndCharacterOfPosition(declaration.getStart(file)).line + 1 };
  };
  const inspect = (component: string, type: ts.Type, symbol: ts.Symbol) => {
    const props = new Set<string>();
    for (const signature of type.getCallSignatures()) {
      const parameter = signature.getParameters()[0];
      if (!parameter) continue;
      const parameterType = checker.getTypeOfSymbolAtLocation(parameter, source);
      for (const member of parameterType.isUnion() ? parameterType.types : [parameterType]) {
        const apparent = checker.getApparentType(member);
        for (const prop of forbiddenProps) if (checker.getPropertyOfType(apparent, prop)) props.add(prop);
      }
    }
    for (const prop of props) found.push({ ...where(symbol), component, prop });
  };
  for (const exported of checker.getExportsOfModule(module)) {
    const name = exported.getName();
    if (!/^[A-Z]/.test(name)) continue;
    const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    if (!(symbol.flags & ts.SymbolFlags.Value)) continue;
    const type = checker.getTypeOfSymbolAtLocation(symbol, source);
    inspect(name, type, symbol);
    for (const part of type.getProperties())
      if (/^[A-Z]/.test(part.getName())) inspect(`${name}.${part.getName()}`, checker.getTypeOfSymbolAtLocation(part, source), part);
  }
  return found;
};

export const rule: Rule = {
  name: "v2-primitive-props",
  description: "No component of @k2b/ui/v2 accepts class, style, size, gap or another layout prop",
  run: async ({ workspaceRoot }) => {
    const entry = join(workspaceRoot, ENTRY);
    if (!existsSync(entry)) return [];
    return forbiddenPrimitiveProps(entry).map(
      ({ file, line, component, prop }): Finding => ({
        file: relative(workspaceRoot, file),
        line,
        message: `${component} accepts \`${prop}\`; a v2 primitive owns its layout, so offer a place or a meaning (variant) instead`,
      }),
    );
  },
};
