import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "@typescript/typescript6";
import { listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

const retiredModule =
  /(?:^|\/)(?:chat-tasks|chat-task-contracts|chat-task-reasons(?:-migrate)?|background-review|background-code-policy|ai-chat-task-routes|ai-chat-tasks-runtime|ai-background-prompt|task-grant-presentation|AssistantTasksDialog|AssistantActivitiesDialog|scheduled-task-format)(?:\.[cm]?[jt]sx?)?$/;

/** Retired execution modules cannot return through a static, re-exported or lazy import. */
export function retiredRoutineImports(file: string, source: string): Finding[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const findings: Finding[] = [];
  const report = (node: ts.Node) => {
    findings.push({
      file,
      line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
      message: "Scheduled chat routines are retired. Use reviewed Code scheduling and chat.run.",
    });
  };
  const visit = (node: ts.Node) => {
    // Include build entrypoints and Bun.file/new URL readers: stale paths fail
    // even when they do not use an import declaration.
    if (ts.isStringLiteralLike(node) && retiredModule.test(node.text)) report(node);
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return findings;
}

export const rule: Rule = {
  name: "retired-chat-routines",
  description: "No imports of retired Assistant routine execution, UI or authority modules",
  run: async ({ workspaceRoot }) =>
    ["packages/cloud/src", "packages/core/src", "packages/assistant/src", "tests"].flatMap((path) =>
      listFiles(join(workspaceRoot, path), sourceFilePattern).flatMap((file) => retiredRoutineImports(file, readFileSync(file, "utf8"))),
    ),
};
