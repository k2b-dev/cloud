import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import ts from "@typescript/typescript6";
import type { Finding, Rule } from "./rule";

/**
 * `packages/cloud/package.json` names in `sideEffects` every module whose import does something. Every other module is
 * free of side effects, so a bundler leaves out what an island does not use: an island that takes
 * `V2WorkspaceNavigation` from the `@k2b/cloud/ssr/islands` barrel no longer carries the help, the launchpad and the
 * panel that other islands use (#4280: about 65 KB). A module missing from the list would be dropped silently where
 * nothing uses its exports: a registration would not happen, a listener would not listen.
 *
 * A module does something on import when, at its top level, it
 * - runs a statement (a call, an assignment, an `await`);
 * - calls a function that writes state of its own module (a Map, a Set, an array or a `let` at the top of the module
 *   that defines it: a registry that another module reads by key), or one named like a registration (`register…`,
 *   `bind…`, `subscribe…`, `listen…`, `install…`) from another package;
 * - calls a global with an effect (`addEventListener`, `customElements.define`, `process.on`, `Bun.plugin`, …) or
 *   makes an object that listens (`new BroadcastChannel`, an observer, a worker, a socket);
 * - or another module imports it for its effect alone (`import "./browser"`).
 */

const skipped = /\.(?:test|spec|test-fixture|browser-harness|browser-fixture|typecheck|bench)\.|\/fixtures?\/|\.fixtures\.|\.d\.ts$/;
const globalRoots = new Set(["window", "document", "globalThis", "self", "process", "customElements", "navigator", "Bun", "sharp"]);
const globalEffects =
  /^(?:addEventListener|define|on|once|plugin|concurrency|cache|setInterval|setTimeout|queueMicrotask|requestAnimationFrame|register)$/;
const namedRegistration = /^(?:register|bind|subscribe|listen|install)[A-Z]/;
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

/** Names of top-level functions that write state of their own module, by name across all modules. */
const registeringFunctions = (sources: ReadonlyMap<string, ts.SourceFile>): Set<string> => {
  const names = new Set<string>();
  for (const source of sources.values()) {
    const state = new Set<string>();
    for (const statement of source.statements)
      if (ts.isVariableStatement(statement))
        for (const declaration of statement.declarationList.declarations)
          if (ts.isIdentifier(declaration.name)) state.add(declaration.name.text);
    const writesState = (body: ts.Node): boolean => {
      let found = false;
      const visit = (node: ts.Node): void => {
        if (found) return;
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          /^(?:set|add|push|unshift|splice)$/.test(node.expression.name.text)
        ) {
          const root = rootName(node.expression.expression);
          if (root && state.has(root)) found = true;
        }
        if (ts.isBinaryExpression(node) && isAssignment(node.operatorToken.kind)) {
          const root = rootName(node.left);
          if (root && state.has(root)) found = true;
        }
        ts.forEachChild(node, visit);
      };
      visit(body);
      return found;
    };
    for (const statement of source.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name && statement.body && writesState(statement.body))
        names.add(statement.name.text);
      if (ts.isVariableStatement(statement))
        for (const declaration of statement.declarationList.declarations)
          if (
            ts.isIdentifier(declaration.name) &&
            declaration.initializer &&
            (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)) &&
            writesState(declaration.initializer.body)
          )
            names.add(declaration.name.text);
    }
  }
  return names;
};

/** Each module (path relative to the package) that does something on import, with why. */
export const sideEffectModules = (files: ReadonlyMap<string, string>): Map<string, string[]> => {
  const sources = new Map<string, ts.SourceFile>();
  for (const [file, text] of files)
    sources.set(
      file,
      ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS),
    );
  const registering = registeringFunctions(sources);
  const found = new Map<string, string[]>();
  const flag = (file: string, why: string) => {
    const reasons = found.get(file) ?? [];
    if (!reasons.includes(why)) reasons.push(why);
    found.set(file, reasons);
  };
  for (const [file, source] of sources) {
    const effects = (node: ts.Node, out: string[]): void => {
      if (ts.isCallExpression(node)) {
        const name = lastName(node.expression);
        const root = rootName(node.expression);
        if (name && (registering.has(name) || namedRegistration.test(name))) out.push(`calls ${name}`);
        else if (root && name && globalRoots.has(root) && globalEffects.test(name)) out.push(`calls ${root}.${name}`);
      }
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && listeningObjects.test(node.expression.text))
        out.push(`makes a ${node.expression.text}`);
      // what a function or class does runs when it is called, not on import
      if (!ts.isFunctionLike(node) && !ts.isClassLike(node)) ts.forEachChild(node, (child) => effects(child, out));
    };
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement) && !statement.importClause && ts.isStringLiteral(statement.moduleSpecifier)) {
        const specifier = statement.moduleSpecifier.text;
        if (!specifier.startsWith(".")) continue;
        const base = normalize(join(dirname(file), specifier)).replace(/\.tsx?$/, "");
        const target = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find((candidate) => files.has(candidate));
        if (target) flag(target, `${file} imports it for its effect`);
      } else if (ts.isExpressionStatement(statement))
        flag(file, `runs \`${statement.expression.getText(source).slice(0, 40).replace(/\s+/g, " ")}\``);
      else if (ts.isVariableStatement(statement)) {
        const out: string[] = [];
        effects(statement, out);
        for (const why of out) flag(file, why);
      }
    }
  }
  return found;
};

const PackageJson = (value: unknown): string[] | undefined => {
  if (!value || typeof value !== "object" || !("sideEffects" in value) || !Array.isArray(value.sideEffects)) return undefined;
  return value.sideEffects.filter((entry): entry is string => typeof entry === "string");
};

export const rule: Rule = {
  name: "cloud-side-effects",
  description: "packages/cloud's sideEffects names exactly the modules whose import does something",
  run: async ({ workspaceRoot }) => {
    const root = join(workspaceRoot, "packages", "cloud");
    const manifest = join(root, "package.json");
    const listed = PackageJson(JSON.parse(readFileSync(manifest, "utf8")));
    if (!listed) return [{ file: manifest, message: "sideEffects must be a list of the modules whose import does something" }];
    const files = new Map<string, string>();
    for await (const file of new Bun.Glob("{src,examples,scripts}/**/*.{ts,tsx}").scan({ cwd: root }))
      if (!skipped.test(file)) files.set(file, readFileSync(join(root, file), "utf8"));
    const effects = sideEffectModules(files);
    const patterns = listed.map((entry) => ({ entry, glob: new Bun.Glob(entry.replace(/^\.\//, "")) }));
    const findings: Finding[] = [];
    for (const [file, why] of [...effects].sort(([a], [b]) => a.localeCompare(b)))
      if (!patterns.some(({ glob }) => glob.match(file)))
        findings.push({
          file: join(root, file),
          message: `does something on import (${why.join("; ")}); add "./${file}" to sideEffects in packages/cloud/package.json, or a bundler drops it where nothing uses its exports`,
        });
    // a listed module that no longer does anything keeps code in every island that reaches it
    for (const { entry } of patterns)
      if (!entry.includes("*") && !effects.has(entry.replace(/^\.\//, "")))
        findings.push({
          file: manifest,
          message: `sideEffects lists ${entry}, which does nothing on import (or no longer exists); remove it`,
        });
    return findings;
  },
};
