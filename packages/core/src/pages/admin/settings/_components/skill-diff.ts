import { diffLines } from "diff";

export type SkillVersionFiles = { markdown: string; references: readonly { path: string; content: string }[] };

export type SkillDiffRow = { kind: "added" | "removed" | "unchanged"; value: string } | { kind: "gap"; count: number };

export type SkillFileDiff = { path: string; rows: SkillDiffRow[]; added: number; removed: number };

/** Unchanged lines shown around each change; longer unchanged runs collapse into one gap row. */
const CONTEXT_LINES = 3;

const lines = (value: string): string[] => {
  const result = value.split("\n");
  if (result.at(-1) === "") result.pop();
  return result;
};

const files = (version: SkillVersionFiles): Map<string, string> =>
  new Map([["SKILL.md", version.markdown], ...version.references.map((reference) => [reference.path, reference.content] as const)]);

const collapse = (rows: SkillDiffRow[]): SkillDiffRow[] => {
  // Distance to the nearest change on either side, in two linear passes: reference files can have many lines.
  const isChange = (row: SkillDiffRow) => row.kind === "added" || row.kind === "removed";
  const distance = rows.map(() => Number.POSITIVE_INFINITY);
  let last = Number.NEGATIVE_INFINITY;
  for (const [index, row] of rows.entries()) {
    if (isChange(row)) last = index;
    distance[index] = index - last;
  }
  last = Number.POSITIVE_INFINITY;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (isChange(rows[index]!)) last = index;
    distance[index] = Math.min(distance[index]!, last - index);
  }
  const hidden = distance.map((value) => value > CONTEXT_LINES);
  const result: SkillDiffRow[] = [];
  for (let index = 0; index < rows.length; ) {
    let end = index;
    while (end < rows.length && hidden[end]) end += 1;
    // A gap row only pays off when it hides more than one line.
    if (end - index > 1) {
      result.push({ kind: "gap", count: end - index });
      index = end;
    } else {
      result.push(rows[index]!);
      index += 1;
    }
  }
  return result;
};

/**
 * Line differences from the installed Skill to the app's version, one entry per changed file.
 * `removed` lines exist only in the installed Skill, `added` lines only in the app version.
 */
export const diffSkillVersions = (current: SkillVersionFiles, app: SkillVersionFiles): SkillFileDiff[] => {
  const before = files(current);
  const after = files(app);
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) =>
    a === "SKILL.md" ? -1 : b === "SKILL.md" ? 1 : a.localeCompare(b),
  );
  return paths.flatMap((path) => {
    const from = before.get(path) ?? "";
    const to = after.get(path) ?? "";
    if (from === to) return [];
    const rows = diffLines(from, to).flatMap((part) =>
      lines(part.value).map((value): SkillDiffRow => ({ kind: part.added ? "added" : part.removed ? "removed" : "unchanged", value })),
    );
    return [
      {
        path,
        rows: collapse(rows),
        added: rows.filter((row) => row.kind === "added").length,
        removed: rows.filter((row) => row.kind === "removed").length,
      },
    ];
  });
};
