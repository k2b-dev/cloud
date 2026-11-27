import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import ts from "@typescript/typescript6";
import type { Finding, Rule } from "./rule";

/**
 * `packages/cloud/package.json` names in `sideEffects` every module whose import does something. Every other module is
 * free of side effects, so a bundler leaves out what an island does not use: an island that takes
 * `V2WorkspaceNavigation` from the `@k2b/cloud/ssr/islands` barrel no longer carries the help, the launchpad and the
 * panel that other islands use (#4280). A module missing from the list would be dropped silently where nothing uses
 * its exports: a registration would not happen, a listener would not listen. So the list is derived, and this rule
 * keeps it exact in both directions.
 *
 * A module does something on import when, at its top level, it
 * - has any statement other than an import, an export or a declaration (`if`, `try`, `for`, a call, an assignment);
 * - evaluates, in a variable's initializer, in `export default`, in an immediately called function, in a decorator or
 *   in a static block or field of a class, one of these:
 *   - a call to a function that registers: one that writes state its module shares (a Map, Set, array or `let` that
 *     is exported or read by another function of the module; never a WeakMap or WeakSet, which only the holder of the
 *     key can read), or that calls such a function; or one named like a registration (`register…`, `bind…`,
 *     `subscribe…`, `listen…`, `install…`) from another package;
 *   - a registering method on a shared object (`registry.add(…)`, `bus.on(…)`, `app.use(…)`);
 *   - an effect on a global (`addEventListener`, `customElements.define`, `process.on`, `Bun.plugin`, an assignment to
 *     `globalThis.…`), or an object that listens (`new BroadcastChannel`, an observer, a worker, a socket);
 * - or imports something for its effect alone (`import "pkg"`); the module it imports that way, in this package, does
 *   something too.
 * Writes inside a function the call returns (an object's methods, a closure) happen later, not on import, so they do not
 * make the function register; a cache that only its own function reads (`markedFor`) is no registry either.
 * The scan covers `src` (without tests, fixtures and worker entries, which are built as entries of their own) and the
 * `scripts` that `src` imports.
 */

const skipped =
  /\.(?:test|spec|test-fixture|browser-harness|browser-fixture|typecheck|bench)\.|\/fixtures?\/|\.fixtures\.|\.d\.ts$|-worker\.tsx?$/;
const globalRoots = new Set(["window", "document", "globalThis", "self", "process", "customElements", "navigator", "Bun", "sharp"]);
const globalEffects =
  /^(?:addEventListener|define|on|once|plugin|concurrency|cache|setInterval|setTimeout|queueMicrotask|requestAnimationFrame|register)$/;
const namedRegistration = /^(?:register|bind|subscribe|listen|install)[A-Z]/;
const registeringMethods = /^(?:add|set|push|unshift|register|on|once|subscribe|listen|use|install|bind|addEventListener)$/;
const listeningObjects =
  /^(?:BroadcastChannel|MutationObserver|ResizeObserver|IntersectionObserver|PerformanceObserver|Worker|SharedWorker|EventSource|WebSocket)$/;

/** The identifier a chain of calls and property reads starts from: `z` for `z.string().datetime()`. */
const rootName = (expression: ts.Expression): string | undefined => {
  let current = expression;
  for (;;) {
    if (ts.isIdentifier(current)) return current.text;
    if (
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current) ||
      ts.isCallExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current)
    )
      current = current.expression;
    else return undefined;
  }
};
const lastName = (expression: ts.Expression): string | undefined =>
  ts.isPropertyAccessExpression(expression) ? expression.name.text : ts.isIdentifier(expression) ? expression.text : undefined;
const isAssignment = (kind: ts.SyntaxKind) => kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
const unwrap = (expression: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)
    ? unwrap(expression.expression)
    : expression;
/** A function expression that is called where it stands: `(() => …)()`. */
const calledNow = (node: ts.Node): boolean => {
  let current = node;
  while (current.parent && ts.isParenthesizedExpression(current.parent)) current = current.parent;
  return !!current.parent && ts.isCallExpression(current.parent) && current.parent.expression === current;
};
const isFunction = (node: ts.Node): node is ts.ArrowFunction | ts.FunctionExpression =>
  ts.isArrowFunction(node) || ts.isFunctionExpression(node);
const exported = (node: ts.Node) =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
/** A function that runs later than its parent: returned, a property or method of an object, or kept in a variable. */
const runsLater = (node: ts.Node) =>
  (isFunction(node) || ts.isMethodDeclaration(node) || ts.isAccessor(node)) &&
  (ts.isReturnStatement(node.parent) ||
    ts.isPropertyAssignment(node.parent) ||
    ts.isObjectLiteralExpression(node.parent) ||
    ts.isVariableDeclaration(node.parent) ||
    ts.isArrowFunction(node.parent) ||
    ts.isClassLike(node.parent));

type Imported = { specifier: string; name: string };
type Module = {
  file: string;
  source: ts.SourceFile;
  /** Local names bound by imports, with where they come from (`name` is `default`, `*` or the exported name). */
  imports: Map<string, Imported>;
  /** Names this module re-exports from another: `export { a as b } from "./x"` and `export * from "./x"`. */
  reexports: Map<string, Imported>;
  stars: string[];
  state: Set<string>;
};

const parse = (file: string, text: string): Module => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const imports = new Map<string, Imported>();
  const reexports = new Map<string, Imported>();
  const stars: string[] = [];
  const declared = new Map<string, ts.VariableDeclaration>();
  const exportedNames = new Set<string>();
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && statement.importClause && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      if (clause.name) imports.set(clause.name.text, { specifier, name: "default" });
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) imports.set(bindings.name.text, { specifier, name: "*" });
      if (bindings && ts.isNamedImports(bindings))
        for (const element of bindings.elements)
          imports.set(element.name.text, { specifier, name: (element.propertyName ?? element.name).text });
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;
      if (!statement.exportClause) stars.push(specifier);
      else if (ts.isNamedExports(statement.exportClause))
        for (const element of statement.exportClause.elements)
          reexports.set(element.name.text, { specifier, name: (element.propertyName ?? element.name).text });
    }
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name)) {
          declared.set(declaration.name.text, declaration);
          if (exported(statement)) exportedNames.add(declaration.name.text);
        }
    if (
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    )
      for (const element of statement.exportClause.elements) exportedNames.add((element.propertyName ?? element.name).text);
  }
  // State a module shares: exported, or read by a top-level declaration other than the one that writes it. A cache only
  // its own function reads is no registry; a WeakMap or WeakSet can only be read by the holder of its key.
  const holders = new Map<string, Set<string>>();
  for (const statement of source.statements) {
    const owner =
      ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)
        ? statement.name?.text
        : ts.isVariableStatement(statement)
          ? statement.declarationList.declarations.map((declaration) => declaration.name.getText(source)).join(",")
          : "";
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && declared.has(node.text) && node.parent && !ts.isVariableDeclaration(node.parent))
        holders.set(node.text, (holders.get(node.text) ?? new Set()).add(owner ?? ""));
      ts.forEachChild(node, visit);
    };
    visit(statement);
  }
  const state = new Set<string>();
  for (const [name, declaration] of declared) {
    const init = declaration.initializer && unwrap(declaration.initializer);
    if (init && ts.isNewExpression(init) && ts.isIdentifier(init.expression) && /^Weak(?:Map|Set|Ref)$/.test(init.expression.text))
      continue;
    if (init && isFunction(init)) continue;
    if (exportedNames.has(name) || (holders.get(name)?.size ?? 0) > 1) state.add(name);
  }
  return { file, source, imports, reexports, stars, state };
};

/** Where a name of a module is defined: `file#name`, following imports and re-exports within the package. */
const definition = (
  modules: ReadonlyMap<string, Module>,
  aliases: Record<string, string[]>,
  file: string,
  name: string,
  seen = new Set<string>(),
): string | undefined => {
  const key = `${file}#${name}`;
  if (seen.has(key)) return undefined;
  seen.add(key);
  const module = modules.get(file);
  if (!module) return undefined;
  const imported = module.imports.get(name) ?? module.reexports.get(name);
  if (imported) {
    if (imported.name === "*") return undefined;
    const [target] = resolveImport(file, imported.specifier, modules, aliases);
    return target ? definition(modules, aliases, target, imported.name, seen) : undefined;
  }
  for (const specifier of module.stars)
    for (const target of resolveImport(file, specifier, modules, aliases)) {
      const found = definition(modules, aliases, target, name, seen);
      if (found) return found;
    }
  return key;
};

/** What a call names: the definition of `f(…)` or of `namespace.f(…)` in this package, or undefined for others. */
const calledDefinition = (
  modules: ReadonlyMap<string, Module>,
  aliases: Record<string, string[]>,
  module: Module,
  callee: ts.Expression,
): string | undefined => {
  if (ts.isIdentifier(callee)) return definition(modules, aliases, module.file, callee.text);
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    const imported = module.imports.get(callee.expression.text);
    if (imported?.name !== "*") return undefined;
    const [target] = resolveImport(module.file, imported.specifier, modules, aliases);
    return target ? definition(modules, aliases, target, callee.name.text) : undefined;
  }
  return undefined;
};

/** Top-level functions (`file#name`) that, when called, write state their module shares, or call such a function. */
const registeringFunctions = (modules: ReadonlyMap<string, Module>, aliases: Record<string, string[]>): Set<string> => {
  const direct = new Map<string, { writes: boolean; calls: Set<string> }>();
  for (const module of modules.values()) {
    const { source, state } = module;
    const inspect = (body: ts.Node) => {
      const found = { writes: false, calls: new Set<string>() };
      const visit = (node: ts.Node): void => {
        if (node !== body && runsLater(node)) return;
        if (ts.isCallExpression(node)) {
          const called = calledDefinition(modules, aliases, module, unwrap(node.expression));
          if (called) found.calls.add(called);
          if (
            ts.isPropertyAccessExpression(node.expression) &&
            /^(?:set|add|push|unshift|splice|delete|clear)$/.test(node.expression.name.text)
          ) {
            const root = rootName(node.expression.expression);
            if (root && state.has(root)) found.writes = true;
          }
        }
        if (ts.isBinaryExpression(node) && isAssignment(node.operatorToken.kind)) {
          const root = rootName(node.left);
          if (root && (state.has(root) || globalRoots.has(root))) found.writes = true;
        }
        ts.forEachChild(node, visit);
      };
      visit(body);
      return found;
    };
    for (const statement of source.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name && statement.body)
        direct.set(`${module.file}#${statement.name.text}`, inspect(statement.body));
      if (ts.isVariableStatement(statement))
        for (const declaration of statement.declarationList.declarations)
          if (ts.isIdentifier(declaration.name) && declaration.initializer && isFunction(unwrap(declaration.initializer)))
            direct.set(`${module.file}#${declaration.name.text}`, inspect((unwrap(declaration.initializer) as ts.ArrowFunction).body));
    }
  }
  const registering = new Set([...direct].filter(([, found]) => found.writes).map(([id]) => id));
  // a wrapper around a registration registers too
  for (let grew = true; grew; ) {
    grew = false;
    for (const [id, found] of direct)
      if (!registering.has(id) && [...found.calls].some((call) => registering.has(call))) {
        registering.add(id);
        grew = true;
      }
  }
  return registering;
};

const resolveImport = (
  from: string,
  specifier: string,
  files: ReadonlyMap<string, unknown>,
  aliases: Record<string, string[]>,
): string[] => {
  const bases = specifier.startsWith("#")
    ? (aliases[specifier] ?? []).map((target) => normalize(target).replace(/\.tsx?$/, ""))
    : specifier.startsWith(".")
      ? [normalize(join(dirname(from), specifier)).replace(/\.tsx?$/, "")]
      : [];
  return bases.flatMap((base) =>
    [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].filter((candidate) => files.has(candidate)),
  );
};

/** Each module (path relative to the package) that does something on import, with why. `aliases` maps `#` imports. */
export const sideEffectModules = (files: ReadonlyMap<string, string>, aliases: Record<string, string[]> = {}): Map<string, string[]> => {
  const modules = new Map([...files].map(([file, text]) => [file, parse(file, text)] as const));
  const registering = registeringFunctions(modules, aliases);
  const found = new Map<string, string[]>();
  const flag = (file: string, why: string) => {
    const reasons = found.get(file) ?? [];
    if (!reasons.includes(why)) reasons.push(why);
    found.set(file, reasons);
  };
  for (const module of modules.values()) {
    const { file, source, imports, state } = module;
    const shared = (root: string | undefined) => root !== undefined && (imports.has(root) || state.has(root));
    const effects = (node: ts.Node, out: string[]): void => {
      if (ts.isCallExpression(node)) {
        const callee = unwrap(node.expression);
        const name = lastName(callee);
        const root = rootName(callee);
        // an immediately called function: its body runs now, and the walk below looks into it
        if (isFunction(callee)) {
          // nothing of its own; its statements are inspected as the walk continues
        } else if (
          name &&
          (registering.has(calledDefinition(modules, aliases, module, callee) ?? "") ||
            (!calledDefinition(modules, aliases, module, callee) && namedRegistration.test(name)))
        )
          out.push(`calls ${name}`);
        else if (root && name && globalRoots.has(root) && globalEffects.test(name)) out.push(`calls ${root}.${name}`);
        else if (ts.isPropertyAccessExpression(callee) && name && registeringMethods.test(name) && shared(rootName(callee.expression)))
          out.push(`calls ${callee.getText(source).slice(0, 40)}`);
      }
      if (ts.isBinaryExpression(node) && isAssignment(node.operatorToken.kind)) {
        const root = rootName(node.left);
        if (root && globalRoots.has(root)) out.push(`assigns ${node.left.getText(source).slice(0, 40)}`);
      }
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && listeningObjects.test(node.expression.text))
        out.push(`makes a ${node.expression.text}`);
      if (ts.isDecorator(node)) out.push("has a decorator");
      // what a function or a method does runs when it is called, not on import; an immediately called one runs now
      if (ts.isFunctionLike(node) && !calledNow(node)) return;
      ts.forEachChild(node, (child) => effects(child, out));
    };
    const inspect = (node: ts.Node) => {
      const out: string[] = [];
      effects(node, out);
      for (const why of out) flag(file, why);
    };
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement)) {
        if (statement.importClause || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        const specifier = statement.moduleSpecifier.text;
        if (/\.css$/.test(specifier)) continue;
        flag(file, `imports ${specifier} for its effect`);
        for (const target of resolveImport(file, specifier, files, aliases)) flag(target, `${file} imports it for its effect`);
      } else if (ts.isVariableStatement(statement) || ts.isExportAssignment(statement)) inspect(statement);
      else if (ts.isClassDeclaration(statement)) {
        if (ts.getDecorators(statement)?.length) flag(file, `decorates class ${statement.name?.text ?? ""}`);
        for (const member of statement.members) {
          if (ts.isClassStaticBlockDeclaration(member)) flag(file, `runs a static block of ${statement.name?.text ?? "a class"}`);
          else if (ts.getDecorators(member)?.length) flag(file, `decorates a member of ${statement.name?.text ?? "a class"}`);
          else if (
            ts.isPropertyDeclaration(member) &&
            member.initializer &&
            (ts.getModifiers(member) ?? []).some((m) => m.kind === ts.SyntaxKind.StaticKeyword)
          )
            inspect(member.initializer);
        }
      } else if (
        !ts.isExportDeclaration(statement) &&
        !ts.isFunctionDeclaration(statement) &&
        !ts.isInterfaceDeclaration(statement) &&
        !ts.isTypeAliasDeclaration(statement) &&
        !ts.isEnumDeclaration(statement) &&
        !ts.isEmptyStatement(statement) &&
        !(ts.isModuleDeclaration(statement) && (ts.getModifiers(statement) ?? []).some((m) => m.kind === ts.SyntaxKind.DeclareKeyword))
      )
        flag(file, `runs \`${statement.getText(source).slice(0, 40).replace(/\s+/g, " ")}\``);
    }
  }
  return found;
};

/** The sources the rule scans: `src` without tests, fixtures and worker entries, and the `scripts` that `src` imports. */
export const scannedSources = async (root: string, aliases: Record<string, string[]>): Promise<Map<string, string>> => {
  const files = new Map<string, string>();
  for await (const file of new Bun.Glob("src/**/*.{ts,tsx}").scan({ cwd: root }))
    if (!skipped.test(file)) files.set(file, readFileSync(join(root, file), "utf8"));
  const scripts = new Map<string, string>();
  for await (const file of new Bun.Glob("scripts/**/*.{ts,tsx}").scan({ cwd: root }))
    if (!skipped.test(file)) scripts.set(file, readFileSync(join(root, file), "utf8"));
  const queue = [...files.keys()];
  for (const file of queue) {
    const source = ts.createSourceFile(file, files.get(file) ?? "", ts.ScriptTarget.Latest, false);
    for (const statement of source.statements)
      if (
        (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier)
      )
        for (const target of resolveImport(file, statement.moduleSpecifier.text, scripts, aliases))
          if (!files.has(target)) {
            files.set(target, scripts.get(target)!);
            queue.push(target);
          }
  }
  // the file system lists in any order; findings and their reasons come out the same on every machine
  return new Map([...files].sort(([a], [b]) => a.localeCompare(b)));
};

const manifestSchema = (value: unknown): { sideEffects?: string[]; aliases: Record<string, string[]> } => {
  if (!value || typeof value !== "object") return { aliases: {} };
  const list =
    "sideEffects" in value && Array.isArray(value.sideEffects)
      ? value.sideEffects.filter((entry): entry is string => typeof entry === "string")
      : undefined;
  const aliases: Record<string, string[]> = {};
  if ("imports" in value && value.imports && typeof value.imports === "object")
    for (const [name, target] of Object.entries(value.imports)) {
      const targets = typeof target === "string" ? [target] : target && typeof target === "object" ? Object.values(target) : [];
      aliases[name] = targets.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.replace(/^\.\//, ""));
    }
  return { sideEffects: list, aliases };
};

export const rule: Rule = {
  name: "cloud-side-effects",
  description: "packages/cloud's sideEffects names exactly the modules whose import does something",
  run: async ({ workspaceRoot }) => {
    const root = join(workspaceRoot, "packages", "cloud");
    const manifest = join(root, "package.json");
    const { sideEffects: listed, aliases } = manifestSchema(JSON.parse(readFileSync(manifest, "utf8")));
    if (!listed) return [{ file: manifest, message: "sideEffects must be a list of the modules whose import does something" }];
    const effects = sideEffectModules(await scannedSources(root, aliases), aliases);
    const patterns = listed.map((entry) => ({ entry, glob: new Bun.Glob(entry.replace(/^\.\//, "")) }));
    const findings: Finding[] = [];
    for (const [file, why] of [...effects].sort(([a], [b]) => a.localeCompare(b)))
      if (!patterns.some(({ glob }) => glob.match(file)))
        findings.push({
          file: join(root, file),
          message: `does something on import (${why.toSorted().join("; ")}); add "./${file}" to sideEffects in packages/cloud/package.json, or a bundler drops it where nothing uses its exports`,
        });
    // a listed module that does nothing on import keeps code in every island that reaches it
    for (const { entry } of patterns)
      if (!entry.includes("*") && !effects.has(entry.replace(/^\.\//, "")))
        findings.push({
          file: manifest,
          message: `sideEffects lists ${entry}, which does nothing on import (or is not scanned); remove it`,
        });
    return findings;
  },
};
