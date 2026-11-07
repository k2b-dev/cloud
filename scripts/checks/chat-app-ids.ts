import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "@typescript/typescript6";
import { appIds } from "../workspace";
import { isTestFile, listFiles } from "./files";
import type { Finding, Rule } from "./rule";

export const checkSource = (file: string, source: string, apps: readonly string[]): Finding[] => {
  if (isTestFile(file) || /(?:[.-]fixture(?:[.-]|$)|\/fixtures\/)/.test(file)) return [];
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const findings: Finding[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node) ||
      node.kind === ts.SyntaxKind.RegularExpressionLiteral
    ) {
      const literal = node.getText(ast);
      const value =
        node.kind === ts.SyntaxKind.RegularExpressionLiteral ? literal.slice(1, literal.lastIndexOf("/")).replaceAll("\\.", ".") : literal;
      const text =
        ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) ? node.text : value;
      const common = new Set(["mail", "tools", "core", "contacts", "assistant", "accounts"]);
      const app = apps.find(
        (app) =>
          app !== "chat" &&
          (text.startsWith(`${app}.`) ||
            (!text.startsWith(".") && new RegExp(`(?:^|[^a-zA-Z0-9_./-])${app}[.:/][a-zA-Z0-9_-]`).test(text)) ||
            new RegExp(`/app/${app}(?:[^a-zA-Z0-9_-]|$)`).test(text) ||
            (ts.isStringLiteralLike(node) &&
              text === app &&
              !common.has(app) &&
              !(
                app === "oauth" &&
                ts.isBinaryExpression(node.parent) &&
                (node.parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
                  node.parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) &&
                [node.parent.left, node.parent.right].some(
                  (operand) => ts.isPropertyAccessExpression(operand) && operand.name.text === "credentialKind",
                )
              ) &&
              !(app === "pwa" && ts.isPropertyAssignment(node.parent) && node.parent.name.getText(ast) === "layout"))),
      );
      if (app)
        findings.push({
          file,
          line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
          message: `Chat must discover providers: app prefixes (ID followed by ., : or /), /app/ID routes, JSX text, regex patterns and exact quoted uncommon app IDs are forbidden (${app}).`,
        });
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return findings;
};
export const rule: Rule = {
  name: "chat-app-ids",
  description: "Chat discovers providers without knowing other application IDs",
  run: async ({ workspaceRoot }) => {
    const apps = appIds(workspaceRoot);
    return listFiles(join(workspaceRoot, "packages/chat/src"), /\.tsx?$/).flatMap((file) =>
      checkSource(file, readFileSync(file, "utf8"), apps),
    );
  },
};
