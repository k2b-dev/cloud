import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import ts from "@typescript/typescript6";
import type { Finding, Rule } from "./rule";

/**
 * A v2 primitive owns its spacing, lines, height and type (concept rule 2 and rule 4). A prop that hands one of them to
 * the app is a second way to lay out, so no component that `@k2b/ui/v2` exports accepts `class`, `className`,
 * `classList`, `style`, `size`, `gap`, `padding`, `density` or `appearance`; this holds for its dotted parts at any
 * depth (`Workspace.Main`, `Shell.Head.Title`) and for every member of a props union. The rule reads the prop types
 * with the type checker and the compiler options of `packages/ui/tsconfig.json`, so a prop inherited from
 * `JSX.HTMLAttributes` or a spread type counts as well. `Canvas` is no exception: it may draw freely inside, but
 * takes its size from its place.
 *
 * A type the rule cannot see is a finding, never a pass: a module that does not resolve (its types turn into `any`),
 * props typed `any` or `unknown`, a type parameter without a constraint, and props with an index signature, which
 * accept every name, `class` included.
 */
const ENTRY = "packages/ui/src/v2/index.ts";
const CONFIG = "packages/ui/tsconfig.json";
export const forbiddenProps = ["class", "className", "classList", "style", "size", "gap", "padding", "density", "appearance"] as const;
/** Diagnostics that mean a type could not be read: missing modules, missing exports, modules without types. */
const unresolved = new Set([2305, 2307, 2792, 7016]);
const MAX_DEPTH = 6;
const replacement = "a v2 primitive owns its layout, so offer a place or a meaning (variant) instead";

type Found = { file: string; line: number; message: string };

const lineOf = (node: ts.Node) => {
  const file = node.getSourceFile();
  return { file: file.fileName, line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1 };
};

/** Every component of the entry that accepts a layout prop or props the checker cannot see, and every type the program cannot resolve. */
export const forbiddenPrimitiveProps = (entry: string, configPath: string): Found[] => {
  const found: Found[] = [];
  const configErrors: ts.Diagnostic[] = [];
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    { noEmit: true },
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (diagnostic) => configErrors.push(diagnostic) },
  );
  for (const diagnostic of [...configErrors, ...(parsed?.errors ?? [])])
    found.push({
      file: configPath,
      line: 1,
      message: `cannot read the compiler options: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`,
    });
  if (!parsed) return found;

  const program = ts.createProgram({ rootNames: [entry], options: parsed.options });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  const module = source && checker.getSymbolAtLocation(source);
  if (!source || !module) return [...found, { file: entry, line: 1, message: "the v2 entry is no module the type checker can read" }];

  // A type that does not resolve becomes `any`, and `any` has every prop and none: report it instead of passing.
  const v2Root = dirname(entry);
  for (const file of program.getSourceFiles()) {
    if (!file.fileName.startsWith(v2Root)) continue;
    for (const diagnostic of program.getSemanticDiagnostics(file)) {
      if (!unresolved.has(diagnostic.code) || diagnostic.start === undefined) continue;
      found.push({
        file: file.fileName,
        line: file.getLineAndCharacterOfPosition(diagnostic.start).line + 1,
        message: `TS${diagnostic.code} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}; the rule cannot read types it cannot resolve`,
      });
    }
  }

  const where = (symbol: ts.Symbol) => {
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    return declaration ? lineOf(declaration) : { file: entry, line: 1 };
  };
  const opaque = (type: ts.Type): string | undefined => {
    if (type.flags & ts.TypeFlags.Any) return "props of type any";
    if (type.flags & ts.TypeFlags.Unknown) return "props of type unknown";
    if (type.flags & ts.TypeFlags.TypeParameter && !checker.getBaseConstraintOfType(type))
      return "props of an unconstrained type parameter";
    const apparent = checker.getApparentType(type);
    if (checker.getIndexInfoOfType(apparent, ts.IndexKind.String)) return "props with an index signature, which accept any name";
    return undefined;
  };
  const visited = new Set<ts.Type>();
  const inspect = (component: string, type: ts.Type, symbol: ts.Symbol, depth: number) => {
    if (visited.has(type) || depth > MAX_DEPTH) return;
    visited.add(type);
    if (type.flags & ts.TypeFlags.Any) {
      found.push({ ...where(symbol), message: `${component} has the type any; the rule cannot see its props` });
      return;
    }
    const props = new Set<string>();
    const problems = new Set<string>();
    for (const signature of type.getCallSignatures()) {
      const parameter = signature.getParameters()[0];
      if (!parameter) continue;
      const parameterType = checker.getTypeOfSymbolAtLocation(parameter, source);
      for (const member of parameterType.isUnion() ? parameterType.types : [parameterType]) {
        const problem = opaque(member);
        if (problem) {
          problems.add(problem);
          continue;
        }
        const apparent = checker.getApparentType(member);
        for (const prop of forbiddenProps) if (checker.getPropertyOfType(apparent, prop)) props.add(prop);
      }
    }
    for (const problem of problems) found.push({ ...where(symbol), message: `${component} takes ${problem}; name every prop` });
    for (const prop of props) found.push({ ...where(symbol), message: `${component} accepts \`${prop}\`; ${replacement}` });
    // Parts at any depth: Workspace.Main, Shell.Head.Title.
    for (const part of type.getProperties())
      if (/^[A-Z]/.test(part.getName()))
        inspect(`${component}.${part.getName()}`, checker.getTypeOfSymbolAtLocation(part, source), part, depth + 1);
  };
  for (const exported of checker.getExportsOfModule(module)) {
    const name = exported.getName();
    if (!/^[A-Z]/.test(name)) continue;
    const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    if (!(symbol.flags & ts.SymbolFlags.Value)) continue;
    inspect(name, checker.getTypeOfSymbolAtLocation(symbol, source), symbol, 0);
  }
  return found;
};

export const rule: Rule = {
  name: "v2-primitive-props",
  description: "No component of @k2b/ui/v2 accepts class, style, size, gap or another layout prop, or props the checker cannot see",
  run: async ({ workspaceRoot }) => {
    const entry = join(workspaceRoot, ENTRY);
    if (!existsSync(entry)) return [];
    const config = join(workspaceRoot, CONFIG);
    if (!existsSync(config))
      return [{ file: CONFIG, message: "missing; the rule reads the v2 types with the compiler options of packages/ui" }];
    return forbiddenPrimitiveProps(entry, config).map(
      ({ file, line, message }): Finding => ({ file: relative(workspaceRoot, file), line, message }),
    );
  },
};
