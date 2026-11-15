import type { CodeDiffFile, CodeDiffLine } from "@k2b/ui/code-diff";
import { diffArrays } from "diff";
import { z } from "zod";
import { CODE_CHECK_LIMITS } from "../../code/checker-contract";
import { type CodePageInvoke, coreQuery } from "./data";

/**
 * The Code tab reads Core's `code.source.tab` query, which only editors of the automation may call. Each answer carries
 * one bounded chunk of the chosen file and one of the comparison, so the tab asks again until both are complete.
 */
const CHUNK = 16_384;
/** Core keeps every UTF-16 chunk whole and may end one unit early; every file fits in Core's source limit. */
const SOURCE_REQUESTS = Math.ceil(CODE_CHECK_LIMITS.sourceBytes / (CHUNK - 1)) + 1;
/**
 * The comparison is the JSON of every row of both versions. Ordinary code stays well below four times the source of
 * the two versions; a larger comparison is not shown here.
 */
const DIFF_REQUESTS = Math.ceil((8 * CODE_CHECK_LIMITS.sourceBytes) / (CHUNK - 1)) + 1;
/** Past the end of any source: Core then answers with an empty source chunk, so a comparison does not carry it. */
const SKIP_SOURCE = Number.MAX_SAFE_INTEGER;
/** The same budget Core gives its own line comparison; past it the rows stay as Core sent them. */
const DIFF_MS = 100;

const ChunkSchema = z.object({ text: z.string(), nextOffset: z.number().int().nullable() });
const SourceTabSchema = z.object({
  enabled: z.object({ id: z.string(), number: z.number().int(), files: z.array(z.string()) }).nullable(),
  path: z.string().nullable(),
  source: ChunkSchema.nullable(),
  difference: ChunkSchema.nullable(),
  versions: z.array(z.object({ versionId: z.string(), number: z.number().int(), submittedAt: z.string() })),
});
const DiffFilesSchema = z.array(
  z.object({ path: z.string(), lines: z.array(z.object({ kind: z.enum(["same", "add", "del"]), text: z.string() })) }),
);
const VersionIdSchema = z.uuid();

/** An earlier version the person can compare with, newest first. */
export type CodeSourceTabVersion = { versionId: string; number: number; submittedAt: string };
/** The comparison with an earlier version: every file of both, and how many lines came and went in all of them. */
export type CodeSourceTabDiff = { kind: "rows"; files: CodeDiffFile[]; added: number; removed: number } | { kind: "too-large" };
export type CodeSourceTabReady = {
  state: "ready";
  /** The version that is on; its code is what the tab shows. */
  enabled: { id: string; number: number; files: string[] };
  /** Versions before the one that is on, newest first. */
  versions: CodeSourceTabVersion[];
  /** The chosen file. In a comparison it may be a file that only the earlier version has. */
  file: string;
  /** The version the code is compared with, or null for the code alone. */
  compare: string | null;
  /** The chosen file's lines without a comparison; null in a comparison. */
  lines: string[] | null;
  diff: CodeSourceTabDiff | null;
};
export type CodeSourceTabInitial = { state: "error" } | { state: "none" } | CodeSourceTabReady;
/** What the address chooses: `?file=` and `?compare=`. */
export type CodeSourceTabSelection = { file: string | null; compare: string | null };

/** The same line split as Core: an empty file has no line, and a final newline leaves an empty last line. */
const linesOf = (text: string) => (text === "" ? [] : text.split("\n"));

/**
 * Core sends a changed file as all old rows, then all new rows, so the chunks of the same two versions never differ.
 * The tab compares the two sides line by line again; past the time budget the rows stay as Core sent them.
 */
export const compareRows = (files: readonly { path: string; lines: readonly CodeDiffLine[] }[]): CodeDiffFile[] => {
  const deadline = performance.now() + DIFF_MS;
  return files.map((file) => {
    if (!file.lines.some((line) => line.kind !== "same")) return { path: file.path, lines: [...file.lines] };
    const before = file.lines.filter((line) => line.kind !== "add").map((line) => line.text);
    const after = file.lines.filter((line) => line.kind !== "del").map((line) => line.text);
    const remaining = deadline - performance.now();
    const parts = remaining > 0 ? diffArrays(before, after, { timeout: remaining }) : undefined;
    if (!parts) return { path: file.path, lines: [...file.lines] };
    return {
      path: file.path,
      lines: parts.flatMap((part) =>
        part.value.map((text): CodeDiffLine => ({ kind: part.added ? "add" : part.removed ? "del" : "same", text })),
      ),
    };
  });
};

/** One view of the tab: the chosen file of the version that is on, or its comparison with an earlier version. */
export async function loadSourceTabView(
  invoke: CodePageInvoke,
  codeId: string,
  selection: CodeSourceTabSelection,
): Promise<CodeSourceTabInitial> {
  const compare = selection.compare && VersionIdSchema.safeParse(selection.compare).success ? selection.compare : null;
  // A comparison may choose a file the version that is on no longer has; that file is chosen from the comparison.
  const ask = async (input: { path?: string; comparisonVersionId?: string; sourceOffset: number; diffOffset: number }) => {
    const result = await invoke(coreQuery("code.source.tab", { codeId, ...input }), SourceTabSchema);
    return result.ok ? result.data.data : null;
  };
  const first = await ask({
    ...(compare || !selection.file ? {} : { path: selection.file }),
    ...(compare ? { comparisonVersionId: compare } : {}),
    sourceOffset: compare ? SKIP_SOURCE : 0,
    diffOffset: 0,
  });
  if (!first) return { state: "error" };
  const enabled = first.enabled;
  if (!enabled) return { state: "none" };
  if (!first.path) return { state: "error" };
  const versions = first.versions.filter((version) => version.number < enabled.number).sort((a, b) => b.number - a.number);

  if (compare) {
    // Only an earlier version is offered; any other address falls back to the code alone.
    if (!versions.some((version) => version.versionId === compare))
      return loadSourceTabView(invoke, codeId, { ...selection, compare: null });
    let text = first.difference?.text ?? "";
    let next = first.difference?.nextOffset ?? null;
    for (let request = 1; next !== null; request++) {
      if (request >= DIFF_REQUESTS) {
        const file = selection.file ?? first.path;
        return { state: "ready", enabled, versions, file, compare, lines: null, diff: { kind: "too-large" } };
      }
      const more = await ask({ comparisonVersionId: compare, sourceOffset: SKIP_SOURCE, diffOffset: next });
      if (!more?.difference || more.enabled?.id !== enabled.id) return { state: "error" };
      text += more.difference.text;
      next = more.difference.nextOffset;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { state: "error" };
    }
    const parsed = DiffFilesSchema.safeParse(raw);
    if (!parsed.success) return { state: "error" };
    const files = compareRows(parsed.data);
    const changed = files.find((file) => file.lines.some((line) => line.kind !== "same"));
    const wanted = selection.file;
    const file = wanted && files.some((item) => item.path === wanted) ? wanted : (changed ?? files[0])?.path;
    if (!file) return { state: "error" };
    const rows = files.flatMap((item) => item.lines);
    return {
      state: "ready",
      enabled,
      versions,
      file,
      compare,
      lines: null,
      diff: {
        kind: "rows",
        files,
        added: rows.filter((line) => line.kind === "add").length,
        removed: rows.filter((line) => line.kind === "del").length,
      },
    };
  }

  const file = first.path;
  let text = first.source?.text ?? "";
  let next = first.source?.nextOffset ?? null;
  for (let request = 1; next !== null; request++) {
    // Core's own source limit bounds every file; more chunks would mean the answers changed underneath.
    if (request >= SOURCE_REQUESTS) return { state: "error" };
    const more = await ask({ path: file, sourceOffset: next, diffOffset: 0 });
    if (!more?.source || more.enabled?.id !== enabled.id) return { state: "error" };
    text += more.source.text;
    next = more.source.nextOffset;
  }
  return { state: "ready", enabled, versions, file, compare: null, lines: linesOf(text), diff: null };
}

/** The address's choice from `?file=` and `?compare=`. */
export const sourceTabSelection = (url: URL): CodeSourceTabSelection => ({
  file: url.searchParams.get("file") || null,
  compare: url.searchParams.get("compare") || null,
});

/**
 * The first render of the tab, on the server. An address whose file or version no longer fits, such as an old link,
 * opens the code of the version that is on instead of an error.
 */
export async function loadSourceTabInitial(invoke: CodePageInvoke, codeId: string, url: URL): Promise<CodeSourceTabInitial> {
  const selection = sourceTabSelection(url);
  const view = await loadSourceTabView(invoke, codeId, selection);
  if (view.state === "error" && (selection.file || selection.compare))
    return loadSourceTabView(invoke, codeId, { file: null, compare: null });
  return view;
}
