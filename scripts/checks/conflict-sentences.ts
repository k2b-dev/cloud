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

/** The literal messages an argument can end up as: itself, both branches of `?:` and the fallback of `??`. */
const literalsOf = (node: ts.Expression): ts.Expression[] => {
  if (ts.isParenthesizedExpression(node)) return literalsOf(node.expression);
  if (ts.isConditionalExpression(node)) return [...literalsOf(node.whenTrue), ...literalsOf(node.whenFalse)];
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) return literalsOf(node.right);
  return textOf(node) === undefined ? [] : [node];
};

/**
 * A sentence says what happened or what to do: it has a finite verb ("Passkey already exists", "Task changed; read it
 * and retry") or starts a clause with a request ("Complete all blocking tasks first", "…; configure one explicitly").
 * A subject alone, such as "API key", "Running turn" or "Tag with that name", has neither. Words that are also nouns
 * count only in their -s and -ed forms ("holds", not "Preservation hold"); requests that are also nouns count only
 * before an object ("Review the request", not "Review request").
 */
const FINITE =
  /\b(?:is|are|was|were|isn't|aren't|wasn't|has|have|had|hasn't|haven't|can|cannot|can't|could|must|may|might|should|will|won't|would|does|do|did|doesn't|don't|didn't|exists?|belongs?|needs|needed|conflicts|overlaps|overlapped|holds|held|differs?|matches|blocks|uses|reached|changed|moved|deleted|removed|expired|revoked|started|stopped|finished|ended|failed|fails|claims|claimed|requires|lacks|contains|refers|points|pointed|owns|waits|waited|runs|ran|exceeds|redirects|went|became|lost|sent)\b/i;
const CLAUSE = String.raw`(?:^|[;:.]\s*)`;
const REQUEST = new RegExp(
  `${CLAUSE}(?:add|apply|approve|ask|assign|cancel|choose|clear|close|complete|configure|confirm|connect|create|delete|disable|disconnect|enable|finish|give|join|keep|leave|publish|read|reconnect|refresh|reload|remove|rename|reopen|replace|resolve|restore|resume|retry|revoke|save|select|send|unlock|upgrade)\\b`,
  "i",
);
const NOUN_REQUEST = new RegExp(
  `${CLAUSE}(?:archive|change|check|contact|edit|end|fix|load|merge|move|open|pause|pick|release|reset|review|run|set|sign|split|start|stop|switch|try|turn|undo|update|use|wait)\\s+(?:the|a|an|it|this|that|these|those|them|one|all|your|its|their|again|first|for)\\b`,
  "i",
);
export const isSentence = (text: string): boolean => FINITE.test(text) || REQUEST.test(text.trim()) || NOUN_REQUEST.test(text.trim());

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
      const texts = message ? literalsOf(message).map((literal) => textOf(literal) ?? "") : [""];
      if (texts.some((text) => !isSentence(text)))
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
