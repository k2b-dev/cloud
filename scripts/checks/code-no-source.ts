import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { capture, type Finding, type Rule } from "./rule";

const BASELINE = "scripts/checks/code-no-source.baseline";
const baselineKey = (finding: Finding) => JSON.stringify([finding.file, finding.message]);
const baselineHeader = [
  "# Known code-no-source findings, grouped by rendering file: [file, message, count].",
  "# New findings fail even when another finding disappears; --fix only lowers or removes entries.",
  "# The UI lanes must empty this baseline before the v12 preview (#3357).",
];
const formatBaseline = (baseline: ReadonlyMap<string, number>) =>
  `${[
    ...baselineHeader,
    ...[...baseline]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, count]) => {
        const [file, message] = JSON.parse(key);
        return JSON.stringify([file, message, count]);
      }),
  ].join("\n")}\n`;

const readBaseline = (path: string): Map<string, number> => {
  const baseline = new Map<string, number>();
  if (!existsSync(path)) return baseline;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const entry: unknown = JSON.parse(line);
    if (
      !Array.isArray(entry) ||
      entry.length !== 3 ||
      typeof entry[0] !== "string" ||
      typeof entry[1] !== "string" ||
      typeof entry[2] !== "number" ||
      !Number.isSafeInteger(entry[2]) ||
      entry[2] < 1
    )
      throw new Error(`Invalid code-no-source baseline entry: ${line}`);
    const key = baselineKey({ file: entry[0], message: entry[1] });
    if (baseline.has(key)) throw new Error(`Duplicate code-no-source baseline entry: ${line}`);
    baseline.set(key, entry[2]);
  }
  return baseline;
};

/** Compare exact findings, not just file totals: replacing an old violation cannot hide a new one. */
export function compareCodeSourceBaseline(findings: readonly Finding[], baseline: ReadonlyMap<string, number>, fix = false) {
  const current = new Map<string, Finding[]>();
  for (const finding of findings) {
    const key = baselineKey(finding);
    const matches = current.get(key) ?? [];
    matches.push(finding);
    current.set(key, matches);
  }
  const failures: Finding[] = [];
  const remaining = new Map(baseline);
  let lowered = false;
  for (const [key, matches] of current) failures.push(...matches.slice(baseline.get(key) ?? 0));
  for (const [key, count] of baseline) {
    const actual = current.get(key)?.length ?? 0;
    if (actual >= count) continue;
    if (fix) {
      if (actual) remaining.set(key, actual);
      else remaining.delete(key);
      lowered = true;
    } else {
      failures.push({
        file: BASELINE,
        message: `${key} has ${actual} finding(s), below its baseline of ${count}; lower/remove the entry (bun scripts/check.ts code-no-source --fix).`,
      });
    }
  }
  return { failures, remaining, lowered };
}

/** Visible text only: resource IDs in links and opaque data attributes are navigation, not labels. */
export function codeSurfaceFindings(name: string, text: string, file = "scripts/fixtures/code-surfaces.render.ts"): Finding[] {
  const patterns = [
    /\bcode\.tsx?\b/gi,
    /(?<![\w./:-])\b[\w./-]+\.[a-z]{1,8}:\d+(?::\d+)?\b/gi,
    /\bcode_[a-z_]+\b/g,
    /\$\.calls\b/g,
    /\btest\/[^\s]+\.json\b/g,
    /\b(?:sp|c|sa|mb|grid|nb)_[a-z0-9]{4,}\b/gi,
    /\b[0-9a-f]{8,64}\b/gi,
    /\b[0-9a-f]{4}…[0-9a-f]{2}\b/gi,
    /(?:^|[.!?\n]\s*)(?:Passt|OK|Gut|Fertig|Done)(?=$|[.!?\n])/gi,
  ];
  return patterns.flatMap((pattern) =>
    [...text.matchAll(pattern)].map((match) => ({
      file,
      message: `${name}: visible technical text or an unqualified status: ${JSON.stringify(match[0])}`,
    })),
  );
}
export const rule: Rule = {
  name: "code-no-source",
  description: "Code render fixtures contain no source, technical IDs or unqualified result words outside the two source fields",
  async run({ workspaceRoot, fix }) {
    const result = await capture([process.execPath, "scripts/fixtures/code-surfaces.render.ts"], { cwd: workspaceRoot });
    if (result.code !== 0) return [{ message: `Code surface fixtures failed to render: ${result.output}` }];
    const fixtures: unknown = JSON.parse(result.output);
    if (!Array.isArray(fixtures) || !fixtures.length) return [{ message: "No Code render fixtures were checked." }];
    const findings: Finding[] = [];
    for (const value of fixtures) {
      const fixture: unknown = value;
      if (
        !fixture ||
        typeof fixture !== "object" ||
        !("file" in fixture) ||
        typeof fixture.file !== "string" ||
        !("name" in fixture) ||
        !("text" in fixture) ||
        typeof fixture.name !== "string" ||
        typeof fixture.text !== "string"
      )
        return [{ message: "Invalid Code render fixture output." }];
      findings.push(...codeSurfaceFindings(fixture.name, fixture.text, fixture.file));
    }
    const baselinePath = join(workspaceRoot, BASELINE);
    const compared = compareCodeSourceBaseline(findings, readBaseline(baselinePath), fix);
    if (compared.lowered) writeFileSync(baselinePath, formatBaseline(compared.remaining));
    return compared.failures;
  },
};
