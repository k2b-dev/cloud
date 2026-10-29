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
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const app = apps.find(
        (app) =>
          app !== "chat" &&
          (node.text.startsWith(`${app}.`) ||
            (!node.text.startsWith(".") && new RegExp(`(?:^|[^a-zA-Z0-9_-])${app}\\.[a-zA-Z0-9_-]`).test(node.text)) ||
            node.text.includes(`/app/${app}/`) ||
            (node.text === app &&
              !(node.text === "pwa" && ts.isPropertyAssignment(node.parent) && node.parent.name.getText(ast) === "layout"))),
      );
      if (app)
        findings.push({
          file,
          line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
          message: `Chat must discover resource providers; it must not know the application ID ${app}.`,
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
