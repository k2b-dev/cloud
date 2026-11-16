import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "@typescript/typescript6";
import { workspacePackages } from "../workspace";
import { isTestFile, listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

/** The text of a literal message, with each `${…}` part as one word. */
const textOf = (node: ts.Expression): string | undefined =>
  ts.isStringLiteralLike(node)
    ? node.text
    : ts.isTemplateExpression(node)
      ? [node.head.text, ...node.templateSpans.map((span) => ` X ${span.literal.text}`)].join("")
      : undefined;

/**
 * A sentence says what happened or what to do: it has a finite verb ("Passkey already exists", "Task changed; read it
 * and retry") or starts a clause with a request ("Complete all blocking tasks first", "…; configure one explicitly").
 * A subject alone, such as "API key", "Running turn" or "Tag with that name", has neither.
 */
const FINITE =
  /\b(?:is|are|was|were|isn't|aren't|wasn't|has|have|had|hasn't|haven't|can|cannot|can't|could|must|may|might|should|will|won't|would|does|do|did|doesn't|don't|didn't|exists?|needs?|belongs?|conflicts|overlaps?|holds?|differs?|matches|blocks|uses|reached|changed|moved|deleted|removed|expired|revoked|started|stopped|finished|ended|failed|fails|claims?|claimed|requires?|lacks?|contains?|refers?|points?|owns?|waits?|runs|ran|exceeds?|redirects?|went|became|lost|sent)\b/i;
const REQUEST =
  /(?:^|[;:.]\s*)(?:add|apply|approve|archive|ask|assign|cancel|change|check|choose|clear|close|complete|configure|confirm|connect|contact|create|delete|disable|disconnect|edit|enable|end|finish|fix|give|join|keep|leave|load|merge|move|open|pause|pick|publish|read|reconnect|refresh|release|reload|remove|rename|reopen|replace|reset|resolve|restore|resume|retry|review|revoke|run|save|select|send|set|sign|split|start|stop|switch|try|turn|undo|unlock|update|upgrade|use|wait)\b/i;
export const isSentence = (text: string): boolean => FINITE.test(text) || REQUEST.test(text.trim());

export const checkSource = (file: string, source: string): Finding[] => {
  if (!source.includes("conflict(")) return [];
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const findings: Finding[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "conflict" &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "err"
    ) {
      const [message] = node.arguments;
      const text = message ? textOf(message) : "";
      if (text !== undefined && !isSentence(text))
        findings.push({
          file,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          message:
            'err.conflict takes the whole sentence a person reads, such as "Passkey already exists"; it appends nothing since @k2b/stdlib 0.33.0 (#1326)',
        });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
};

export const rule: Rule = {
  name: "conflict-sentences",
  description: "err.conflict gets a whole sentence with a verb, not a subject",
  run: async ({ workspaceRoot }) =>
    [...workspacePackages(workspaceRoot), "scripts"]
      .flatMap((root) => listFiles(join(workspaceRoot, root), sourceFilePattern))
      .filter((file) => !isTestFile(file))
      .sort()
      .flatMap((file) => checkSource(file, readFileSync(file, "utf8"))),
};
