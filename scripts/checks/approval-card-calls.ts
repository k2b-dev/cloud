import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { isTestFile, listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

/**
 * Approvals look the same everywhere, so a person always recognises one (capability views, F5; Gustav v12 3g).
 * `ApprovalFrame` draws every approval, `ApprovalCard` fills it for Capability Actions; a place passes data and
 * answers to either, never a class, a style, a variant, or a spread that could carry one. `Chat.Decision` draws only
 * inside `ApprovalFrame`, and only its own stylesheets style it.
 */
const FRAME_FILE = "packages/cloud/src/approvals/ApprovalFrame.tsx";
const DECISION_STYLES = ["packages/ui/src/styles/index.css", "packages/cloud/src/styles/approvals.css"];
const LOOK_PROPS = /(?:^|\s)(class|classList|style|variant|appearance|tone|look)(?=[\s=/]|$)/;

const line = (source: string, index: number) => source.slice(0, index).split("\n").length;

/** The text of each `<ApprovalCard …>` opening tag, honouring braces so `=>` inside props does not end it. */
const openingTags = (source: string): { index: number; text: string }[] => {
  const tags: { index: number; text: string }[] = [];
  for (const match of source.matchAll(/<(?:ApprovalCard|ApprovalFrame)\b/g)) {
    let depth = 0;
    let end = match.index + match[0].length;
    for (; end < source.length; end++) {
      const char = source[end];
      if (char === "{") depth++;
      else if (char === "}") depth--;
      else if (char === ">" && depth === 0) break;
    }
    tags.push({ index: match.index, text: source.slice(match.index, end) });
  }
  return tags;
};

/** Strips the values inside braces, so only the prop names of one tag remain. */
const propNames = (tag: string): string => {
  let depth = 0;
  let names = "";
  for (const char of tag) {
    if (char === "{") {
      if (depth === 0) names += "{";
      depth++;
    } else if (char === "}") depth--;
    else if (depth === 0) names += char;
  }
  return names;
};

/** A spread at the top level of the tag, such as `{...props}`, could carry any of the look props. */
const hasSpread = (tag: string): boolean => {
  let depth = 0;
  for (let index = 0; index < tag.length; index++) {
    if (tag[index] === "{") {
      if (depth === 0 && /^\{\s*\.\.\./.test(tag.slice(index))) return true;
      depth++;
    } else if (tag[index] === "}") depth--;
  }
  return false;
};

export const checkSource = (file: string, source: string): Finding[] => {
  if (isTestFile(file) || file.includes(".browser-harness.") || file.includes("/packages/ui/")) return [];
  const findings: Finding[] = [];
  for (const tag of openingTags(source)) {
    const look = hasSpread(tag.text) ? "spread" : LOOK_PROPS.exec(propNames(tag.text))?.[1];
    if (look)
      findings.push({
        file,
        line: line(source, tag.index),
        message: `${tag.text.startsWith("<ApprovalFrame") ? "ApprovalFrame" : "ApprovalCard"} takes no look props (${look}): approvals look the same in every place.`,
      });
  }
  // A renamed import (`Chat as C`, `ChatDecision as D`) draws the same decision under another name.
  const aliases = [...source.matchAll(/\b(?:Chat|ChatDecision)\s+as\s+([A-Za-z_$][\w$]*)/g)].map((match) => match[1]!);
  const drawn = new RegExp(
    `<Chat\\.Decision\\b|\\bChatDecision\\b(?!Props|State|Answer|Reason|Fact)${aliases.map((alias) => `|<${alias}(?:\\.Decision)?\\b`).join("")}`,
    "g",
  );
  if (!file.endsWith(FRAME_FILE))
    for (const match of source.matchAll(drawn))
      findings.push({
        file,
        line: line(source, match.index),
        message:
          "Draw approvals with ApprovalFrame or ApprovalCard from @k2b/cloud/approvals/ui; Chat.Decision belongs to ApprovalFrame alone.",
      });
  return findings;
};

export const checkStyles = (file: string, source: string, owner: boolean): Finding[] => {
  if (owner) return [];
  const match = /\.k2b-chat-decision(?:__|\b)/.exec(source);
  return match
    ? [{ file, line: line(source, match.index), message: "Only the decision card's own stylesheets style .k2b-chat-decision." }]
    : [];
};

export const rule: Rule = {
  name: "approval-card-calls",
  description: "Approvals draw through ApprovalFrame with one look",
  run: async ({ workspaceRoot }) => {
    const packages = join(workspaceRoot, "packages");
    const sources = listFiles(packages, sourceFilePattern).flatMap((file) => checkSource(file, readFileSync(file, "utf8")));
    const styles = listFiles(packages, /\.css$/).flatMap((file) =>
      checkStyles(file, readFileSync(file, "utf8"), DECISION_STYLES.includes(relative(workspaceRoot, file))),
    );
    return [...sources, ...styles];
  },
};
