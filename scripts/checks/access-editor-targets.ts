import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "@typescript/typescript6";
import { isTestFile, listFiles } from "./files";
import type { Finding, Rule } from "./rule";

/** Resource editors supply identity, never their own account-search transport. */
export const checkSource = (file: string, source: string): Finding[] => {
  if (isTestFile(file) || file.endsWith(".browser-harness.tsx")) return [];
  // App access is not a resource reference: it uses the app-access management service, without a resource reader.
  if (file.endsWith("/cloud/src/access/AppAccessEditor.tsx")) return [];
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings: Finding[] = [];
  const report = (node: ts.Node) =>
    findings.push({
      file,
      line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
      message: "Resource share editors must pass target: { type, id }; the platform supplies targeted service-account lookup by default.",
    });
  // These pick identities for installation-wide rules or membership, rather than resource shares.
  const identityPickers = [
    "/accounts/src/frontend/service-accounts/DirectoryShares.island.tsx",
    "/core/src/pages/admin/ai/AiBudgetDetail.island.tsx",
    "/core/src/pages/admin/ai/AiModelDetail.island.tsx",
    "/core/src/pages/admin/settings/_components/AiQuotaRules.tsx",
    "/chat/src/frontend/MemberPicker.tsx",
  ];
  const sharedEditor = ["/cloud/src/access/AccessDialog.tsx", "/cloud/src/access/PermissionEditor.tsx"].some((suffix) =>
    file.endsWith(suffix),
  );
  const initializer = (name: string, at: ts.Node): ts.Expression | undefined => {
    for (let scope: ts.Node | undefined = at.parent; scope; scope = scope.parent) {
      if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
      for (const statement of scope.statements) {
        if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
        const declaration = statement.declarationList.declarations.find((decl) => ts.isIdentifier(decl.name) && decl.name.text === name);
        if (declaration) return declaration.initializer;
      }
    }
  };
  // Last write wins: an opaque later spread may erase even an explicit target.
  type Fields = { values: Map<string, string>; unknown: boolean };
  const fields = (expression: ts.Expression | undefined, seen = new Set<ts.Node>()): Fields => {
    if (!expression || seen.has(expression)) return { values: new Map(), unknown: true };
    const next = new Set(seen).add(expression);
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression))
      return fields(expression.expression, next);
    if (ts.isIdentifier(expression)) return fields(initializer(expression.text, expression), next);
    if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
      const fn = initializer(expression.expression.text, expression);
      if (fn && ts.isArrowFunction(fn)) {
        const returned = ts.isBlock(fn.body) ? fn.body.statements.find(ts.isReturnStatement)?.expression : fn.body;
        return fields(returned, next);
      }
    }
    if (!ts.isObjectLiteralExpression(expression)) return { values: new Map(), unknown: true };
    const result = new Map<string, string>();
    let unknown = false;
    for (const prop of expression.properties) {
      if (ts.isSpreadAssignment(prop)) {
        const spread = fields(prop.expression, next);
        if (spread.unknown) {
          result.clear();
          unknown = true;
        }
        for (const [key, value] of spread.values) result.set(key, value);
      } else if (prop.name) {
        const name = prop.name.getText(tree).replaceAll(/['"]/g, "");
        const value = ts.isPropertyAssignment(prop) ? prop.initializer.getText(tree) : name;
        result.set(name, value);
      }
    }
    return { values: result, unknown };
  };
  const validTarget = (props: Map<string, string>) => {
    const target = props.get("target");
    return target !== undefined && !["undefined", "null", "false", "void 0"].includes(target);
  };
  const excludesCode = (value: string | undefined): boolean => {
    if (!value) return false;
    const source = ts.createSourceFile("kinds.ts", `(${value})`, ts.ScriptTarget.Latest, true);
    const statement = source.statements[0];
    if (!statement || !ts.isExpressionStatement(statement) || !ts.isParenthesizedExpression(statement.expression)) return false;
    const array = statement.expression.expression;
    return (
      ts.isArrayLiteralExpression(array) &&
      array.elements.length > 0 &&
      array.elements.every((item) => ts.isStringLiteral(item) && item.text !== "code")
    );
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === "openAccessDialog" && !sharedEditor) {
      if (!validTarget(fields(node.arguments[0]).values)) report(node);
    }
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const tag = node.tagName.getText(tree);
      if (
        ["PermissionEditor", "AccessDialog", "PrincipalPicker"].includes(tag) &&
        !sharedEditor &&
        !tree.statements.some((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === tag)
      ) {
        const props = new Map<string, string>();
        for (const prop of node.attributes.properties) {
          if (ts.isJsxSpreadAttribute(prop)) {
            const spread = fields(prop.expression);
            if (spread.unknown) props.clear();
            for (const [key, value] of spread.values) props.set(key, value);
          } else {
            const value = prop.initializer;
            props.set(
              prop.name.getText(tree),
              value && ts.isJsxExpression(value) ? (value.expression?.getText(tree) ?? "true") : (value?.getText(tree) ?? "true"),
            );
          }
        }
        const disabled =
          props.get("allowServiceAccounts") === "false" || props.get("canEdit") === "false" || props.get("readOnly") === "true";
        const identityOnly =
          tag === "PrincipalPicker" &&
          (identityPickers.some((suffix) => file.endsWith(suffix)) || excludesCode(props.get("serviceAccountKinds")));
        if (!disabled && !identityOnly && !validTarget(props)) report(node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return findings;
};

export const rule: Rule = {
  name: "access-editor-targets",
  description: "Resource share editors supply their target for the built-in service-account lookup",
  run: async ({ workspaceRoot }) =>
    listFiles(join(workspaceRoot, "packages"), /\.tsx$/)
      .sort()
      .flatMap((file) => checkSource(file, readFileSync(file, "utf8"))),
};
