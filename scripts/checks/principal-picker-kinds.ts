import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "@typescript/typescript6";
import { isTestFile, listFiles } from "./files";
import type { Finding, Rule } from "./rule";

/** Restrictions belong to the owning identity contract, never an accidental picker default. */
const restrictions: Record<string, string> = {
  "packages/assistant/src/artifacts/StudioPermissions.tsx": "Studio execution binds personal storage, secrets and approvals to a user.",
  "packages/filesv2/src/frontend/Templates.tsx": "Files template use requires a storage owner's user and Unix identity.",
  "packages/core/src/pages/admin/rail/RailAdmin.island.tsx": "Rail audiences select browser navigation for people, not resource authority.",
  "packages/chat/src/frontend/MemberPicker.tsx":
    "Chat's existing participant model is user-backed; its membership migration owns this restriction.",
};

export const checkSource = (file: string, source: string): Finding[] => {
  if (isTestFile(file) || (!source.includes("PermissionEditor") && !source.includes("PrincipalPicker"))) return [];
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const pickerNames = new Set(["PermissionEditor", "PrincipalPicker"]);
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const binding of bindings.elements) {
      if (pickerNames.has((binding.propertyName ?? binding.name).text)) pickerNames.add(binding.name.text);
    }
  }
  const findings: Finding[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const tag = node.tagName.getText(parsed);
      if (pickerNames.has(tag)) {
        for (const attribute of node.attributes.properties) {
          if (!ts.isJsxAttribute(attribute) || attribute.name.getText(parsed) !== "allowServiceAccounts") continue;
          const value = attribute.initializer;
          // The only forwarding component delegates the same default to PrincipalPicker.
          if (file === "packages/cloud/src/access/PermissionEditor.tsx") continue;
          if (!value || (ts.isJsxExpression(value) && value.expression?.kind === ts.SyntaxKind.TrueKeyword)) continue;
          if (restrictions[file]) continue;
          findings.push({
            file,
            line: parsed.getLineAndCharacterOfPosition(attribute.getStart(parsed)).line + 1,
            message:
              "Principal pickers include service accounts by default. Document a necessary identity restriction in principal-picker-kinds.ts before excluding them.",
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return findings;
};

export const rule: Rule = {
  name: "principal-picker-kinds",
  description: "Shared grant and assignment pickers include machine principals unless their identity contract documents a restriction",
  run: async ({ workspaceRoot }) =>
    listFiles(join(workspaceRoot, "packages"), /\.tsx$/).flatMap((file) =>
      checkSource(relative(workspaceRoot, file), readFileSync(file, "utf8")),
    ),
};
