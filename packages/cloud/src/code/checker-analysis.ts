import { posix } from "node:path";
import ts from "@typescript/typescript6";
import { CodeInternetOriginSchema } from "../contracts/code-internet";
import { MANDATE_POLICY_MAX_IDENTIFIERS } from "../services/mandates/policy";
import { normalizeWorkflowSchedule } from "../workflows/runtime/schedule";
import type { CodeCheckDiagnostic, CodeCheckRequest, CodePermission, CodeVersionManifest } from "./checker-contract";
import { codeSdkPhaseDiagnostic } from "./types";

export type CodeAnalysis = {
  diagnostics: CodeCheckDiagnostic[];
  permissions: CodePermission[];
  entrypoints: CodeVersionManifest["entrypoints"];
  ai: boolean;
  internet: string[];
  modules: string[];
};
const root = "/code/";
/** Pure compiler analysis: user modules are virtual files. Only TypeScript's bundled standard libraries may be read from disk. */
export function analyzeCode(request: CodeCheckRequest): CodeAnalysis {
  const options: ts.CompilerOptions = {
    strict: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.Preserve,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: [],
    noEmit: true,
    skipLibCheck: true,
    verbatimModuleSyntax: true,
  };
  const disk = ts.createCompilerHost(options);
  const files = new Map(Object.entries(request.files).map(([name, value]) => [root + name, value]));
  files.set(root + "sdk.d.ts", request.sdk.declarations);
  const libDir = posix.dirname(ts.getDefaultLibFilePath(options));
  const allowedLib = (name: string) => name.startsWith(`${libDir}/lib.`) && name.endsWith(".d.ts");
  const readFile = (name: string) => files.get(name) ?? (allowedLib(name) ? disk.readFile(name) : undefined);
  const host: ts.CompilerHost = {
    ...disk,
    getCurrentDirectory: () => root,
    readFile,
    fileExists: (name) => files.has(name) || (allowedLib(name) && disk.fileExists(name)),
    getSourceFile: (name, languageVersion) => {
      const source = readFile(name);
      return source === undefined ? undefined : ts.createSourceFile(name, source, languageVersion, true);
    },
    resolveModuleNames: (names, containing) =>
      names.map((name) => {
        const resolved = name === "@sdk" ? root + "sdk.d.ts" : resolveLocal(name, containing.slice(root.length), request.files);
        return resolved ? { resolvedFileName: name === "@sdk" ? resolved : root + resolved } : undefined;
      }),
  };
  const program = ts.createProgram(
    [
      root + request.entry,
      ...Object.keys(request.files)
        .filter((name) => name !== request.entry)
        .map((name) => root + name),
      root + "sdk.d.ts",
    ],
    options,
    host,
  );
  const reachable = new Set<string>();
  const ordered: string[] = [];
  function include(name: string) {
    if (reachable.has(name)) return;
    reachable.add(name);
    const sf = program.getSourceFile(root + name);
    for (const specifier of sf ? runtimeModuleSpecifiers(sf) : []) {
      const dependency = resolveLocal(specifier, name, request.files);
      if (dependency) include(dependency);
    }
    ordered.push(name);
  }
  include(request.entry);
  let collecting = false;
  const checker = program.getTypeChecker();
  const result: CodeAnalysis = { diagnostics: [], permissions: [], entrypoints: [], ai: false, internet: [], modules: [...reachable] };
  const report = (node: ts.Node, code: string, message: string) => {
    const sf = node.getSourceFile();
    const location = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    result.diagnostics.push({
      code,
      message,
      file: sf.fileName.slice(root.length),
      line: location.line + 1,
      column: location.character + 1,
    });
  };
  function strings(type: ts.Type): string[] | null {
    if (type.isStringLiteral()) return [type.value];
    if (type.isUnion()) {
      const values = type.types.map(strings);
      return values.every((value) => value !== null) ? [...new Set(values.flatMap((value) => value ?? []))] : null;
    }
    return null;
  }
  const literals = (node: ts.Node) => strings(checker.getTypeAtLocation(node));
  const propertyType = (type: ts.Type, key: string, node: ts.Node) => {
    const property = checker.getPropertyOfType(type, key);
    return property ? checker.getTypeOfSymbolAtLocation(property, node) : undefined;
  };
  function handle(node: ts.Node, type = checker.getTypeAtLocation(node)): { type: string; ids: string[] | null } | null {
    const target = propertyType(type, "type", node);
    const id = propertyType(type, "id", node);
    const types = target && strings(target);
    if (!types || types.length !== 1 || !id) return null;
    return { type: types[0]!, ids: strings(id) };
  }
  const unparen = (node: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(node) ? unparen(node.expression) : node);
  function member(node: ts.Expression): { base: ts.Expression; path: string[] } {
    const path: string[] = [];
    let base = unparen(node);
    while (ts.isPropertyAccessExpression(base) || ts.isElementAccessExpression(base)) {
      if (handle(base)) break;
      const names = ts.isPropertyAccessExpression(base) ? [base.name.text] : base.argumentExpression && literals(base.argumentExpression);
      if (!names || names.length !== 1) break;
      path.unshift(names[0]!);
      base = unparen(base.expression);
    }
    return { base, path };
  }
  const signatureInSdk = (node: ts.CallExpression) =>
    checker.getResolvedSignature(node)?.declaration?.getSourceFile().fileName === root + "sdk.d.ts";
  const permission = (node: ts.Node, operation: string, target: ReturnType<typeof handle>) => {
    if (target && !target.ids && request.sdk.manifest.mode === "resource") {
      report(
        node,
        "code_dynamic_target",
        `Ziel von \`${ts.isCallExpression(node) ? node.expression.getText() : node.getText()}\` ist nicht erkennbar. Leg die Ziele als Konstante an.`,
      );
      return;
    }
    if (!collecting) return;
    const sf = node.getSourceFile();
    for (const id of target?.ids ?? [null]) {
      result.permissions.push({
        operation,
        target: target ? { type: target.type, id } : null,
        file: sf.fileName.slice(root.length),
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      });
    }
    if (request.aiOperations.includes(operation)) result.ai = true;
  };
  const origins = new Set<string>();
  const allowedOrigins = new Set<string>();
  const dynamicHttp: ts.CallExpression[] = [];
  // A prefix must finish the complete authority before any dynamic expression begins.
  function prefix(node: ts.Expression): string | null {
    node = unparen(node);
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isTemplateExpression(node)) return node.head.text;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return prefix(node.left);
    return null;
  }
  function origin(value: string): string | null {
    try {
      const url = new URL(value);
      return !url.username &&
        !url.password &&
        !/[\\\s\u0000-\u001f\u007f]/.test(value) &&
        CodeInternetOriginSchema.safeParse(url.origin).success
        ? url.origin
        : null;
    } catch {
      return null;
    }
  }
  function httpCall(node: ts.CallExpression, method: string | undefined) {
    const arg = node.arguments[0];
    if (method === "allow") {
      if (!arg || !ts.isArrayLiteralExpression(arg) || arg.elements.some((item) => !ts.isStringLiteralLike(item))) {
        report(node, "code_http_allow_literal", 'Deklariere Ursprünge mit http.allow(["https://api.example.com"]) als wörtliche Liste.');
        return;
      }
      for (const item of arg.elements) {
        if (!ts.isStringLiteralLike(item)) continue;
        if (!CodeInternetOriginSchema.safeParse(item.text).success)
          report(item, "code_http_origin_invalid", "Erlaubt sind genaue HTTPS-Ursprünge ohne Platzhalter, Zugangsdaten oder Pfad.");
        else if (collecting) allowedOrigins.add(item.text);
      }
      return;
    }
    const values = arg && literals(arg);
    if (values) {
      for (const value of values) {
        const parsed = origin(value);
        if (!parsed)
          report(node, "code_http_origin_invalid", "http.fetch benötigt einen genauen HTTPS-Ursprung ohne Platzhalter oder Zugangsdaten.");
        else if (collecting) origins.add(parsed);
      }
      return;
    }
    const head = arg && prefix(arg);
    const parsed = head && /^https:\/\/[^/?#]+[/?#]/i.test(head) ? origin(head) : null;
    if (parsed) {
      if (collecting) origins.add(parsed);
    } else if (collecting) dynamicHttp.push(node);
  }
  const events = new Set<string>();
  const entryNames = new Set<string>();
  function visit(node: ts.Node) {
    if (ts.isIdentifier(node) && node.text === "__codeSdk") report(node, "code_reserved_sdk", "__codeSdk ist für den Runner reserviert.");
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const spec = node.moduleSpecifier;
      if (spec) {
        if (
          !ts.isStringLiteral(spec) ||
          (spec.text !== "@sdk" && !resolveLocal(spec.text, node.getSourceFile().fileName.slice(root.length), request.files))
        ) {
          report(node, "code_import_forbidden", "Erlaubt sind nur @sdk und eigene Quelldateien im Code-Projekt.");
        }
        if (ts.isExportDeclaration(node) && ts.isStringLiteral(spec) && spec.text === "@sdk")
          report(node, "code_reserved_sdk", "Das SDK darf nicht weiter exportiert werden.");
        if (
          ts.isImportDeclaration(node) &&
          ts.isStringLiteral(spec) &&
          spec.text === "@sdk" &&
          node.importClause?.namedBindings &&
          ts.isNamespaceImport(node.importClause.namedBindings)
        )
          report(node, "code_reserved_sdk", "Importiere benannte SDK-Exporte.");
      }
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const signatures = checker.getTypeAtLocation(node).getCallSignatures();
      let wrapped: ts.Expression = node;
      while (ts.isParenthesizedExpression(wrapped.parent)) wrapped = wrapped.parent;
      if (
        signatures.some((s) => s.declaration?.getSourceFile().fileName === root + "sdk.d.ts") &&
        !(ts.isCallExpression(wrapped.parent) && wrapped.parent.expression === wrapped)
      )
        report(node, "code_detached_sdk_method", "Rufe SDK-Methoden direkt am Handle oder app auf.");
    }
    if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      const specifier = ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal) ? argument.literal.text : undefined;
      if (!specifier || (specifier !== "@sdk" && !resolveLocal(specifier, node.getSourceFile().fileName.slice(root.length), request.files)))
        report(node, "code_import_forbidden", "Erlaubt sind nur @sdk und eigene Quelldateien im Code-Projekt.");
    }
    if (ts.isImportEqualsDeclaration(node))
      report(node, "code_import_forbidden", "Verwende benannte ESM-Importe aus @sdk oder eigenen Quelldateien.");
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword)
        report(node, "code_import_forbidden", "Dynamische Importe sind nicht erlaubt.");
      if (checker.getTypeAtLocation(node.expression).flags & ts.TypeFlags.Any)
        report(node, "code_unresolved_call", "Der aufgerufenen Funktion fehlt ein erkennbarer Typ. Verwende typisierte SDK-Handles.");
      const { base, path } = member(node.expression);
      const target = handle(base);
      if (target) {
        const appId = target.type === "cloud.app" ? target.ids?.[0] : target.type.split(".")[0];
        const method = path.join(".");
        const op = request.sdk.manifest.operations.find(
          (op) => op.appId === appId && (op.target ?? "cloud.app") === target.type && op.methodPath.join(".") === method,
        );
        const omitted = request.sdk.manifest.omitted.find((op) => op.capability === `${appId}.${method}`);
        if (omitted)
          report(
            node,
            `code_${omitted.reason}`,
            omitted.reason === "stream"
              ? "Streams sind für Code gesperrt."
              : omitted.reason === "code_false"
                ? "Diese Action ist mit code: false für diesen Code gesperrt."
                : "Diese Query ist nur für Apps verfügbar.",
          );
        if (op) {
          permission(node, op.capability, op.target ? target : null);
          const arg = node.arguments[0];
          if (arg)
            for (const [field, expected] of Object.entries(op.refs)) {
              const refType = propertyType(checker.getTypeAtLocation(arg), field, arg);
              const ref = refType && handle(arg, refType);
              if (!ref || ref.type !== expected) report(arg, "code_unresolved_ref", `Zusätzliches Ziel ${field} ist nicht erkennbar.`);
              else permission(node, op.capability, ref);
            }
        } else if (!omitted) report(node, "code_unresolved_call", "Die Operation am Handle ist nicht erkennbar.");
      } else if (signatureInSdk(node)) {
        const method = path.at(-1);
        const appType = checker.getTypeAtLocation(base);
        const declarationOwner = checker.getResolvedSignature(node)?.declaration?.parent.parent;
        // Follow the SDK signature, including destructured HTTP methods.
        const http = declarationOwner && ts.isTypeAliasDeclaration(declarationOwner) && declarationOwner.name.text === "CodeHttp";
        if (http) {
          const signature = checker.getResolvedSignature(node)?.declaration;
          const name = signature && ts.isMethodSignature(signature) && ts.isIdentifier(signature.name) ? signature.name.text : method;
          httpCall(node, name);
        }
        const app = appType.aliasSymbol?.name === "CodeApp" || appType.getSymbol()?.name === "CodeApp";
        if (app && method) {
          const phase = codeSdkPhaseDiagnostic(method);
          if (phase) report(node, phase.code, phase.message);
          if (method === "on") {
            const explicit = node.arguments.length === 3;
            const event = node.arguments[explicit ? 1 : 0];
            const place =
              explicit && node.arguments[0]
                ? handle(node.arguments[0])
                : request.sdk.manifest.owner?.kind === "resource"
                  ? { type: request.sdk.manifest.owner.ref.type, ids: [request.sdk.manifest.owner.ref.id] }
                  : request.sdk.manifest.owner?.kind === "app"
                    ? { type: "cloud.app", ids: [request.sdk.manifest.owner.appId] }
                    : { type: "owner", ids: ["owner"] };
            const eventNames = event && literals(event);
            if (!eventNames || !place?.ids) report(node, "code_dynamic_event", "Ereignis und Ort müssen als Konstanten erkennbar sein.");
            else
              for (const name of eventNames)
                for (const id of place.ids) {
                  const key = JSON.stringify([name, place.type, id]);
                  if (events.has(key))
                    report(node, "code_duplicate_on", "Ein zweites app.on für dasselbe Ereignis am selben Ort ist nicht erlaubt.");
                  events.add(key);
                }
          }
          if (method === "schedule" && collecting) {
            const cron = node.arguments[0] && literals(node.arguments[0]);
            const options = node.arguments[2];
            const nameType = options && propertyType(checker.getTypeAtLocation(options), "name", options);
            const nameProperty =
              options && ts.isObjectLiteralExpression(options)
                ? options.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText() === "name")
                : undefined;
            const nameValue = nameProperty && ts.isPropertyAssignment(nameProperty) ? nameProperty.initializer : undefined;
            const names = nameValue && ts.isStringLiteralLike(nameValue) ? [nameValue.text] : nameType && strings(nameType);
            const name = options ? (names?.length === 1 ? names[0] : undefined) : `schedule:${result.entrypoints.length}`;
            if (
              !cron ||
              cron.length !== 1 ||
              !cron[0]?.trim() ||
              !name ||
              (options && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) ||
              !ts.isExpressionStatement(node.parent) ||
              !ts.isSourceFile(node.parent.parent)
            )
              report(node, "code_static_schedule", "Deklariere Zeitpläne auf Modulebene mit konstantem cron und Namen (name: … as const).");
            else {
              try {
                normalizeWorkflowSchedule({ cron: cron[0]!, timezone: "UTC" });
              } catch {
                report(node, "code_invalid_cron", "Der Zeitplan benötigt einen gültigen Cron-Ausdruck mit fünf Feldern.");
              }
              if (entryNames.has(name)) report(node, "code_duplicate_schedule", "Der Name des Zeitplans ist bereits vergeben.");
              entryNames.add(name);
              const sf = node.getSourceFile();
              result.entrypoints.push({
                kind: "schedule",
                entrypoint: name,
                cron: cron[0]!,
                file: sf.fileName.slice(root.length),
                line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
              });
            }
          }
        } else if (!http) {
          // Recognized factory calls need no permission; detached methods lose their target and are rejected.
          const factory = request.sdk.manifest.handles.some((spec) => path.join(".") === spec.factoryPath.join("."));
          if (!factory) report(node, "code_unresolved_call", "Rufe SDK-Methoden direkt am Handle oder app auf.");
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  const sourceOrder = [...ordered, ...Object.keys(request.files).filter((name) => !reachable.has(name))];
  for (const name of sourceOrder) {
    const sf = program.getSourceFile(root + name)!;
    if (files.has(sf.fileName) && sf.fileName !== root + "sdk.d.ts") {
      if (sf.referencedFiles.length || sf.typeReferenceDirectives.length || sf.libReferenceDirectives.length)
        report(sf, "code_import_forbidden", "Referenz-Direktiven sind nicht erlaubt.");
      // A suppressed type error could hide an SDK call from permission analysis.
      const comments = new Set<number>();
      const checkComment = (start: number, end: number) => {
        if (!comments.has(start) && /@ts-(?:ignore|expect-error|nocheck)\b/.test(sf.text.slice(start, end)))
          report(sf, "code_type_suppression", "Die Typprüfung darf nicht unterdrückt werden.");
        comments.add(start);
      };
      const checkTokenComments = (node: ts.Node) => {
        ts.forEachLeadingCommentRange(sf.text, node.pos, checkComment);
        ts.forEachTrailingCommentRange(sf.text, node.end, checkComment);
        for (const child of node.getChildren(sf)) checkTokenComments(child);
      };
      checkTokenComments(sf);
      collecting = reachable.has(sf.fileName.slice(root.length));
      visit(sf);
    }
  }
  if (!allowedOrigins.size && request.sdk.manifest.mode !== "code_run")
    for (const node of dynamicHttp)
      report(node, "code_http_origin_dynamic", 'Der Ursprung ist dynamisch. Deklariere ihn mit http.allow(["https://api.example.com"]).');
  result.internet = [...new Set([...origins, ...allowedOrigins])].sort();
  if (request.sdk.manifest.mode !== "code_run" && result.internet.length) {
    const grants =
      result.internet.length +
      (request.sdk.manifest.mode === "personal" ? new Set(result.permissions.map((item) => item.operation)).size : 0);
    if (grants > MANDATE_POLICY_MAX_IDENTIFIERS / 2)
      report(
        program.getSourceFile(root + request.entry)!,
        "code_http_grant_limit",
        `Die Internet-Ursprünge und Operationsfreigaben überschreiten das Mandatsbudget von ${MANDATE_POLICY_MAX_IDENTIFIERS / 2} Freigaben. Teile den Code auf.`,
      );
  }
  if (request.sdk.manifest.mode === "code_run") {
    const entry = program.getSourceFile(root + request.entry)!;
    const module = checker.getSymbolAtLocation(entry);
    const exported = module && checker.getExportsOfModule(module).find((s) => s.name === "default");
    if (!exported || !checker.getTypeOfSymbolAtLocation(exported, entry).getCallSignatures().length)
      report(entry, "code_run_entrypoint", "code_run benötigt eine Funktion als default-Export.");
    result.entrypoints.push({ kind: "manual", entrypoint: "run", cron: null, file: request.entry, line: 1 });
  }
  if (!result.entrypoints.length && !result.diagnostics.length)
    report(program.getSourceFile(root + request.entry)!, "code_no_entrypoint", "Lege mindestens einen Zeitplan auf Modulebene an.");
  return result;
}

/** Resolve only supplied project files. No directories, packages, absolute paths or traversal outside the project. */
export function resolveLocal(specifier: string, containing: string, files: Record<string, string>): string | undefined {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return undefined;
  const base = posix.normalize(posix.join(posix.dirname(containing), specifier));
  if (base.startsWith("../") || base.startsWith("/")) return undefined;
  const candidates = [base, `${base}.ts`, `${base}.tsx`, base.replace(/\.js$/, ".ts"), `${base}/index.ts`];
  return candidates.find((name) => Object.hasOwn(files, name));
}

/** Preserve ESM evaluation dependencies, including empty and inline-type imports/exports.
 * Only a whole-statement import type/export type removes module evaluation. Shared by graph analysis and bundling. */
export function runtimeModuleSpecifiers(sf: ts.SourceFile): string[] {
  return sf.statements.flatMap((statement) => {
    if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))) return [];
    if (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly) return [];
    if (ts.isExportDeclaration(statement) && statement.isTypeOnly) return [];
    return statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? [statement.moduleSpecifier.text] : [];
  });
}
