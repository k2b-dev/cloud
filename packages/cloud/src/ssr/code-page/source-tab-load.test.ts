import { describe, expect, test } from "bun:test";
import { capabilityResultSchema } from "../../contracts/capabilities";
import type { CodePageInvoke } from "./data";
import { SOURCE_TAB_CODE, SOURCE_TAB_CORE_ROWS, SOURCE_TAB_ENABLED, SOURCE_TAB_VERSIONS } from "./source-tab.fixture";
import { compareRows, loadSourceTabInitial, loadSourceTabView } from "./source-tab-load";

/** A newer version, such as one that waits for approval. */
const NEWER = "00000000-0000-4000-8000-000000000005";
type Input = { codeId: string; path?: string; comparisonVersionId?: string; sourceOffset: number; diffOffset: number };

const sources: Record<string, string> = { "code.ts": SOURCE_TAB_CODE.join("\n"), "seite.tsx": "export default 1;\n" };
const chunk = (text: string, offset: number, length: number) => {
  const end = Math.min(text.length, offset + length);
  return { text: text.slice(offset, end), nextOffset: end < text.length ? end : null };
};

/** A fictional Core: the editor gets bounded chunks of 16 KiB, everyone else NOT_FOUND, like `requireCodeSourcePermission`. */
const core = (options: { editor?: boolean; enabled?: boolean; chunk?: number; diff?: string; source?: Record<string, string> } = {}) => {
  const calls: Input[] = [];
  const invoke: CodePageInvoke = async (invocation, schema) => {
    const input = invocation.input as Input;
    calls.push(input);
    if (options.editor === false) return { ok: false, error: { code: "NOT_FOUND", message: "Code not found.", status: 404 } };
    const enabled = options.enabled === false ? null : { ...SOURCE_TAB_ENABLED, codeId: input.codeId };
    const files = options.source ?? sources;
    const path = input.path ?? SOURCE_TAB_ENABLED.files[0]!;
    if (enabled && !Object.hasOwn(files, path))
      return { ok: false, error: { code: "NOT_FOUND", message: "Version content not found.", status: 404 } };
    const known = [...SOURCE_TAB_VERSIONS.map((version) => version.versionId), NEWER];
    if (input.comparisonVersionId && !known.includes(input.comparisonVersionId))
      return { ok: false, error: { code: "NOT_FOUND", message: "Code version not found.", status: 404 } };
    const size = options.chunk ?? 16_384;
    return {
      ok: true,
      data: capabilityResultSchema(schema).parse({
        data: {
          enabled,
          path: enabled ? path : null,
          source: enabled ? chunk(files[path]!, Math.min(input.sourceOffset, files[path]!.length), size) : null,
          difference:
            enabled && input.comparisonVersionId !== undefined
              ? chunk(options.diff ?? JSON.stringify(SOURCE_TAB_CORE_ROWS), input.diffOffset, size)
              : null,
          versions: [
            { versionId: NEWER, number: 5, submittedAt: "2026-11-02T10:00:00.000Z" },
            SOURCE_TAB_VERSIONS[2],
            enabled ? { versionId: enabled.id, number: 4, submittedAt: "2026-10-28T08:00:00.000Z" } : SOURCE_TAB_VERSIONS[1],
            SOURCE_TAB_VERSIONS[0],
            SOURCE_TAB_VERSIONS[1],
          ],
          nextBefore: null,
        },
      }),
    };
  };
  return { invoke, calls };
};

describe("Code tab data", () => {
  test("reads the chosen file of the version that is switched on in bounded chunks and offers only earlier versions", async () => {
    const long = Array.from({ length: 2_000 }, (_, index) => `line(${index});`).join("\n");
    const { invoke, calls } = core({ source: { ...sources, "code.ts": long } });
    const view = await loadSourceTabView(invoke, "c_lea", { file: null, compare: null });
    if (view.state !== "ready") throw new Error(`Expected the code, got ${view.state}`);
    expect(view.file).toBe("code.ts");
    expect(view.lines).toHaveLength(2_000);
    expect(view.lines?.join("\n")).toBe(long);
    expect(view.diff).toBeNull();
    // Newer and the same version are never offered for comparison; newest first.
    expect(view.versions.map((version) => version.number)).toEqual([3, 2, 1]);
    expect(calls.map((call) => call.sourceOffset)).toEqual([0, 16_384]);
    expect(calls.every((call) => call.comparisonVersionId === undefined)).toBe(true);
  });

  test("assembles the comparison, compares the two sides line by line again and counts what came and went", async () => {
    const { invoke, calls } = core({ chunk: 700 });
    const view = await loadSourceTabView(invoke, "c_lea", { file: "seite.tsx", compare: SOURCE_TAB_VERSIONS[0]!.versionId });
    if (view.state !== "ready" || view.diff?.kind !== "rows") throw new Error("Expected a comparison");
    expect(view.lines).toBeNull();
    expect(view.file).toBe("seite.tsx");
    expect(view.diff.added).toBe(2);
    expect(view.diff.removed).toBe(1);
    const code = view.diff.files.find((file) => file.path === "code.ts")!;
    const kinds = code.lines.map((line) => line.kind);
    expect(kinds).toEqual([...Array(7).fill("same"), "del", "add", "add", ...Array(7).fill("same")]);
    // The comparison never carries the source: every request skips it.
    expect(calls.length).toBeGreaterThan(2);
    expect(calls.every((call) => call.sourceOffset > 1_000_000 && call.path === undefined)).toBe(true);
  });

  test("a version that is not earlier, or no version at all, falls back to the code alone", async () => {
    const { invoke } = core();
    const unknown = await loadSourceTabView(invoke, "c_lea", { file: null, compare: NEWER });
    expect(unknown.state === "ready" && unknown.compare === null && unknown.lines !== null).toBe(true);
    const malformed = await loadSourceTabView(invoke, "c_lea", { file: null, compare: "drop table" });
    expect(malformed.state === "ready" && malformed.compare === null).toBe(true);
  });

  test("without a version that is switched on there is no code, also not of a waiting version", async () => {
    const { invoke } = core({ enabled: false });
    expect(await loadSourceTabView(invoke, "c_lea", { file: null, compare: null })).toEqual({ state: "none" });
  });

  // F30: only editors read source. Core refuses everyone else with NOT_FOUND; the page then shows no code at all.
  test("a reader or a Cloud admin without the editor right gets the error state and no code", async () => {
    const { invoke, calls } = core({ editor: false });
    const initial = await loadSourceTabInitial(invoke, "c_lea", new URL("https://cloud.test/mail/m/code?tab=code&file=code.ts"));
    expect(initial).toEqual({ state: "error" });
    expect(JSON.stringify(initial)).not.toContain("import");
    // One retry without the address's choice, then the error stands.
    expect(calls).toHaveLength(2);
  });

  test("an old address whose file is gone opens the first file instead of an error", async () => {
    const { invoke } = core();
    const initial = await loadSourceTabInitial(invoke, "c_lea", new URL("https://cloud.test/mail/m/code?tab=code&file=alt.ts"));
    expect(initial.state === "ready" && initial.file === "code.ts").toBe(true);
  });

  test("requests stay bounded: a comparison past its budget is too large, a source that never ends fails", async () => {
    const huge = core({ diff: "x".repeat(3_000_000) });
    const tooLarge = await loadSourceTabView(huge.invoke, "c_lea", { file: null, compare: SOURCE_TAB_VERSIONS[0]!.versionId });
    expect(tooLarge.state === "ready" && tooLarge.diff?.kind === "too-large").toBe(true);
    expect(huge.calls.length).toBeLessThanOrEqual(130);

    const endless = core({ source: { "code.ts": "y".repeat(400_000), "seite.tsx": "" } });
    expect(await loadSourceTabView(endless.invoke, "c_lea", { file: null, compare: null })).toEqual({ state: "error" });
    expect(endless.calls.length).toBeLessThanOrEqual(18);
  });

  test("a changed file is compared again; an unchanged file keeps its rows", () => {
    const rows = [
      {
        path: "a.ts",
        lines: [
          { kind: "del" as const, text: "a" },
          { kind: "add" as const, text: "b" },
        ],
      },
    ];
    expect(compareRows(rows)).toEqual([{ path: "a.ts", lines: rows[0]!.lines }]);
    expect(compareRows([{ path: "b.ts", lines: [{ kind: "same" as const, text: "x" }] }])[0]!.lines).toEqual([{ kind: "same", text: "x" }]);
  });
});
