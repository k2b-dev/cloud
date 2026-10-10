import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { listFiles } from "./files";
import type { Finding, Rule } from "./rule";

/**
 * Built-in Help follows the writing rules in `docs-site/docs/en/build/write-app-help.md`:
 * a sentence in a numbered step has at most `MAX_STEP_WORDS` words, and the text
 * uses no synonym that the Cloud glossary lists for a product term.
 *
 * Findings that existed when the rule was introduced live in `help-writing.baseline`.
 * They are reported as known, not as failures, and the baseline only shrinks:
 * a new finding fails, and so does a baseline line whose finding is gone.
 * `--fix` removes those lines; `--warnings` lists every known finding.
 */
export const MAX_STEP_WORDS = 20;

const GLOSSARY = "docs-site/docs/en/reference/glossary.md";
const BASELINE = "scripts/checks/help-writing.baseline";
const GLOSSARY_HEADER = ["English", "German", "Meaning", "Not in English", "Not in German"];

type Locale = "en" | "de";
type Term = { locale: Locale; text: string; preferred: string; pattern: RegExp };
/** One finding; `key` identifies it in the baseline without a line number, so edits elsewhere do not move it. */
export type HelpFinding = { file: string; line: number; key: string; message: string };

const cells = (row: string): string[] =>
  row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole words only: letters, digits, and hyphens continue a word, so `double-click` is not `click`. */
const termPattern = (text: string): RegExp => {
  const prefix = text.endsWith("*");
  const word = prefix ? text.slice(0, -1) : text;
  const first = word[0]!;
  const head = first === first.toLowerCase() && first !== first.toUpperCase() ? `[${first}${first.toUpperCase()}]` : escape(first);
  const body = escape(word.slice(1)).replace(/ /g, "\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}-])${head}${body}${prefix ? "[\\p{L}\\p{N}]*" : ""}(?![\\p{L}\\p{N}-])`, "gu");
};

/** Reads every glossary table with the shared header; the avoid columns hold backticked terms. */
export const parseGlossary = (source: string): Term[] => {
  const terms: Term[] = [];
  let inTable = false;
  for (const line of source.split("\n")) {
    if (!line.trim().startsWith("|")) {
      inTable = false;
      continue;
    }
    const row = cells(line);
    if (row.join("|") === GLOSSARY_HEADER.join("|")) {
      inTable = true;
      continue;
    }
    if (!inTable || row.every((cell) => /^-+$/.test(cell))) continue;
    const [english = "", german = "", , avoidEnglish = "", avoidGerman = ""] = row;
    for (const [locale, preferred, avoid] of [
      ["en", english, avoidEnglish],
      ["de", german, avoidGerman],
    ] as const) {
      for (const match of avoid.matchAll(/`([^`]+)`/g)) {
        terms.push({ locale, text: match[1]!, preferred: preferred.replace(/\*\*/g, ""), pattern: termPattern(match[1]!) });
      }
    }
  }
  return terms;
};

/** Text a reader sees as prose: no code, bold interface labels, link targets, heading metadata, or HTML. */
const prose = (line: string): string =>
  line
    .replace(/`[^`]*`/g, " ")
    .replace(/\*\*[^*]+\*\*/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\{icon="[^"]*"\}/g, " ");

/** Text whose words count in a step: labels and code stay as words, markup does not. */
const stepText = (text: string): string =>
  text
    .replace(/`[^`]*`/g, "code")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

const ABBREVIATIONS = /\b(?:e\.g\.|i\.e\.|etc\.|vs\.|z\. ?B\.|d\. ?h\.|u\. ?a\.|bzw\.|ggf\.|ca\.|usw\.|Nr\.)/g;

/** Splits at sentence ends; dots of known abbreviations become U+2024 meanwhile so they do not end a sentence. */
export const sentences = (text: string): string[] =>
  text
    .replace(ABBREVIATIONS, (match) => match.replace(/\./g, "․"))
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.replace(/․/g, ".").trim())
    .filter(Boolean);

export const wordCount = (sentence: string): number => sentence.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;

const localeOf = (file: string): Locale => (basename(dirname(file)) === "de" ? "de" : "en");

/** Checks one Help article. `file` is the repository-relative path used in findings and keys. */
export const checkHelpSource = (file: string, source: string, terms: readonly Term[]): HelpFinding[] => {
  const findings: HelpFinding[] = [];
  const locale = localeOf(file);
  const localTerms = terms.filter((term) => term.locale === locale);
  const lines = source.split("\n");

  // A bold label can wrap onto the next source line; carry it so its second half stays exempt.
  let openBold = false;
  const checkTerms = (text: string, line: number) => {
    if (!text.trim()) openBold = false;
    let visible = text;
    if (openBold) {
      const end = visible.indexOf("**");
      visible = end === -1 ? "" : visible.slice(end + 2);
      openBold = end === -1;
    }
    visible = prose(visible);
    const start = visible.indexOf("**");
    if (start !== -1) {
      visible = visible.slice(0, start);
      openBold = true;
    }
    for (const term of localTerms) {
      for (const match of visible.matchAll(term.pattern)) {
        findings.push({
          file,
          line,
          key: `${file} | term | ${term.text}`,
          message: `Glossary: write “${term.preferred}”, not “${match[0].replace(/\s+/g, " ")}” (${GLOSSARY}).`,
        });
      }
    }
  };

  let index = 0;
  if (lines[0] === "---") {
    for (index = 1; index < lines.length && lines[index] !== "---"; index += 1) {
      const field = lines[index]!.match(/^(title|description):\s*(.*)$/);
      if (field) checkTerms(field[2]!, index + 1);
    }
    index += 1;
  }

  let fenced = false;
  let step: { line: number; text: string[] } | null = null;
  const closeStep = () => {
    if (!step) return;
    for (const sentence of sentences(stepText(step.text.join(" ")))) {
      const words = wordCount(sentence);
      if (words <= MAX_STEP_WORDS) continue;
      const excerpt = sentence.split(/\s+/).slice(0, 8).join(" ");
      findings.push({
        file,
        line: step.line,
        key: `${file} | step | ${excerpt}`,
        message: `Step sentence has ${words} words (at most ${MAX_STEP_WORDS}): “${excerpt} …”`,
      });
    }
    step = null;
  };

  for (; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^\s*(```|~~~)/.test(line)) {
      closeStep();
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;

    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (numbered) {
      closeStep();
      step = { line: index + 1, text: [numbered[1]!] };
    } else if (step && line.trim() && !/^\s*(?:[-*+]\s|#|:::|>|\|)/.test(line)) {
      step.text.push(line.trim());
    } else {
      closeStep();
    }

    const callout = line.match(/^:::\w+\s*(.*)$/);
    checkTerms(callout ? callout[1]! : line, index + 1);
  }
  closeStep();
  return findings;
};

/** Every Help Markdown file below `packages/*\/src/help`, sorted. */
export const helpFiles = (workspaceRoot: string): string[] => {
  const packagesRoot = join(workspaceRoot, "packages");
  if (!existsSync(packagesRoot)) return [];
  return readdirSync(packagesRoot)
    .flatMap((name) => listFiles(join(packagesRoot, name, "src", "help"), /\.md$/))
    .sort();
};

export const collectHelpFindings = (workspaceRoot: string): HelpFinding[] => {
  const terms = parseGlossary(readFileSync(join(workspaceRoot, GLOSSARY), "utf8"));
  return helpFiles(workspaceRoot).flatMap((path) => checkHelpSource(relative(workspaceRoot, path), readFileSync(path, "utf8"), terms));
};

const BASELINE_HEADER = [
  "# Known help-writing findings, one per line: <file> | <step|term> | <detail>.",
  "# The Help rewrite removes lines until the file is empty; the rule never adds lines.",
  "# `bun scripts/check.ts help-writing --fix` removes lines whose finding is gone.",
];

export const formatBaseline = (keys: readonly string[]): string => `${[...BASELINE_HEADER, ...[...keys].sort()].join("\n")}\n`;

const readBaseline = (path: string): string[] =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
    : [];

export const rule: Rule = {
  name: "help-writing",
  description: "Help steps keep sentences short and Help uses the Cloud glossary terms",
  run: async ({ workspaceRoot, fix, flags }) => {
    const baselinePath = join(workspaceRoot, BASELINE);
    const remaining = new Map<string, number>();
    for (const key of readBaseline(baselinePath)) remaining.set(key, (remaining.get(key) ?? 0) + 1);

    const known: HelpFinding[] = [];
    const failures: Finding[] = [];
    for (const finding of collectHelpFindings(workspaceRoot)) {
      const count = remaining.get(finding.key) ?? 0;
      if (count > 0) {
        remaining.set(finding.key, count - 1);
        known.push(finding);
      } else {
        failures.push({ file: join(workspaceRoot, finding.file), line: finding.line, message: finding.message });
      }
    }

    const stale = [...remaining].flatMap(([key, count]) => Array<string>(count).fill(key));
    if (stale.length > 0 && fix) {
      writeFileSync(baselinePath, formatBaseline(known.map((finding) => finding.key)));
    } else {
      for (const key of stale) {
        failures.push({
          file: baselinePath,
          message: `Fixed: remove “${key}” from the baseline (bun scripts/check.ts help-writing --fix).`,
        });
      }
    }

    if (known.length > 0) {
      console.warn(`warn  help-writing: ${known.length} known finding(s) in ${BASELINE}; list them with --warnings`);
      if (flags.has("--warnings")) {
        for (const finding of known) console.warn(`  - ${finding.file}:${finding.line} ${finding.message}`);
      }
    }
    return failures;
  },
};
