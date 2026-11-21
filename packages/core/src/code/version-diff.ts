import { diffArrays } from "diff";
import type { CodeSourceFiles } from "./contracts";
import type { CodeVersionDiffFile } from "./version-contracts";

// Keep every newline byte, including the distinction between a final newline and no final newline.
const lines = (text: string) => (text === "" ? [] : text.split("\n"));
/** A complete linear-space fallback prevents pathological diffs from blocking review.
 * The existing Core diff budget is 100 ms; exhaustion replaces the entire file, preserving every row.
 */
export function codeVersionDiff(
  before: CodeSourceFiles,
  after: CodeSourceFiles,
  mode: "compare" | "replacement" = "compare",
): CodeVersionDiffFile[] {
  const deadline = performance.now() + 100;
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().map((path) => {
    const oldLines = lines(before[path] ?? "");
    const newLines = lines(after[path] ?? "");
    if (before[path] === after[path]) return { path, lines: newLines.map((text) => ({ kind: "same" as const, text })) };
    const remaining = mode === "compare" ? deadline - performance.now() : 0;
    const parts = remaining > 0 ? diffArrays(oldLines, newLines, { timeout: remaining }) : undefined;
    return {
      path,
      lines: parts
        ? parts.flatMap((part) =>
            part.value.map((text) => ({ kind: part.added ? ("add" as const) : part.removed ? ("del" as const) : ("same" as const), text })),
          )
        : [...oldLines.map((text) => ({ kind: "del" as const, text })), ...newLines.map((text) => ({ kind: "add" as const, text }))],
    };
  });
}
