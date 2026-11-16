import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { renderedText } from "../../../../scripts/fixtures/rendered-markup";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-code-diff-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { CodeDiff } = await import("./CodeDiff");
const { LocaleProvider } = await import("../intl/locale");
type Props = Parameters<typeof CodeDiff>[0];
type Line = Props["files"][number]["lines"][number];

const same = (text: string): Line => ({ kind: "same", text });
const add = (text: string): Line => ({ kind: "add", text });
const del = (text: string): Line => ({ kind: "del", text });

// Fictional automation: twelve unchanged lines, one replaced call, three unchanged lines.
const head = Array.from({ length: 12 }, (_, index) => same(`const step${index + 1} = ${index + 1};`));
const reply = [
  ...head,
  del("await draft.create({ text });"),
  add("// Reply to the sender of the event"),
  add("await message.reply({ text });"),
  same("}"),
  same(""),
  same("// end"),
];
const files: Props["files"] = [
  { path: "index.ts", lines: reply },
  {
    path: "reply.test.ts",
    lines: [same("test('replies', () => {"), del("  expect(draft).toBeDefined();"), add("  expect(sent).toHaveLength(1);"), same("});")],
  },
  { path: "params.ts", lines: [same("export const params = {"), same("  window: 2,"), same("};")] },
];

const html = (props: Props, locale = "en") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(CodeDiff, props);
      },
    }),
  );
const text = (markup: string) => renderedText(markup).replace(/&#39;/g, "'");
const rowNumbers = (markup: string) => [...markup.matchAll(/data-row="(\d+)"/g)].map((match) => Number(match[1]));

describe("CodeDiff server rendering", () => {
  test("shows each change with three unchanged lines around it and folds the rest", () => {
    const markup = html({ files });
    // Rows 0–8 fold; rows 9–11 lead into the change, rows 15–17 follow it.
    expect(markup).toContain('class="k2b-code-diff__fold" data-row="0"');
    expect(text(markup)).toContain("9 unchanged lines");
    expect(rowNumbers(markup)).toEqual([0, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(markup).toContain('data-kind="del"');
    expect(markup.match(/data-kind="add"/g)).toHaveLength(2);
    // Old and new numbers count from the rows: the removed line is old 13, the additions new 13 and 14.
    expect(text(markup)).toContain("Removed, line 13:");
    expect(text(markup)).toContain("Added, line 13:");
    expect(text(markup)).toContain("Added, line 14:");
  });

  test("names every file with its change on a tab and labels the code region", () => {
    const markup = html({ files }, "de");
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('aria-label="Dateien"');
    // Names are visible; the change summary is read out with them.
    expect(text(markup)).toContain("index.ts, +2 −1");
    expect(text(markup)).toContain("reply.test.ts, +1 −1");
    expect(text(markup)).toContain("params.ts, gleich");
    expect(markup).toMatch(/<span class="k2b-code-diff__path">index\.ts<\/span><span class="k2b-sr-only">/);
    expect(markup).toContain('aria-label="Code-Unterschied, nur lesen · index.ts"');
    expect(text(markup)).toContain("9 unveränderte Zeilen");
    expect(text(markup)).toContain("Entfernt, Zeile 13:");
  });

  test("opens the fold around a marked line and switches to its file without a click", () => {
    const marked = html({ files, mark: { path: "index.ts", line: 3 } });
    expect(marked).not.toContain("k2b-code-diff__fold");
    expect(marked).toMatch(/data-row="2"[^>]*data-marked="true"[^>]*aria-current="location"/);
    expect(text(marked)).toContain("Marked line.");

    const removed = html({ files, mark: { path: "reply.test.ts", line: 2, side: "old" } });
    expect(removed).toMatch(/aria-selected="true"[^>]*>(?:(?!<\/button>).)*reply\.test\.ts/);
    expect(removed).toMatch(/data-row="1" data-kind="del" data-marked="true"/);
  });

  test("shows a version without predecessor as whole code with one number column", () => {
    const first = [{ path: "index.ts", lines: reply.filter((line) => line.kind !== "del").map((line) => add(line.text)) }];
    const markup = html({ files: first }, "de");
    expect(markup).toContain('data-whole="true"');
    expect(markup).not.toContain("data-kind");
    expect(markup).not.toContain("k2b-code-diff__fold");
    expect(markup).not.toContain("k2b-code-diff__sign");
    expect(text(markup)).toContain("index.ts, 17 Zeilen");
    // Whole code alone is just the code; "new file" only stands beside a file with a predecessor.
    expect(markup).toContain('aria-label="Code-Unterschied, nur lesen · index.ts"');
    const mixed = html({ files: [...first, files[2]!] }, "de");
    expect(mixed).toContain('aria-label="Code-Unterschied, nur lesen · index.ts, neue Datei"');
    // A file the application has not loaded yet carries no summary.
    const lazy = html({ files: [...first, { path: "later.ts", lines: [] }] }, "de");
    expect(text(lazy)).toContain("later.ts");
    expect(text(lazy)).not.toContain("later.ts,");
    expect(rowNumbers(markup)).toHaveLength(17);
  });

  test("an unchanged file is one fold, and code without any change is one quiet state", () => {
    const markup = html({ files, file: "params.ts" });
    expect(rowNumbers(markup)).toEqual([0]);
    expect(text(markup)).toContain("3 unchanged lines");

    for (const unchanged of [[], [files[2]!]]) {
      const empty = html({ files: unchanged });
      expect(empty).toContain('data-state="empty"');
      expect(text(empty)).toContain("The code is unchanged");
      expect(empty).not.toContain("k2b-code-diff__body");
    }
  });

  test("loading keeps the code surface with one status, and an error offers a retry", () => {
    const loading = html({ files: [], status: "loading" });
    expect(loading).toMatch(/class="k2b-code-diff__body" role="status" aria-busy="true"/);
    expect(loading.match(/k2b-code-diff__loading/g)).toHaveLength(8);
    expect(text(loading)).toContain("Loading the code");

    const failed = html({ files, status: "error", errorDescription: "Nothing was decided.", onRetry: () => {} }, "de");
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("ti ti-cloud-off");
    expect(text(failed)).toContain("Der Code konnte nicht geladen werden");
    expect(text(failed)).toContain("Nothing was decided.");
    expect(text(failed)).toContain("Erneut versuchen");
    expect(failed).not.toContain("k2b-code-diff__line");
  });

  test("renders a large file page by page and still reaches a marked line on a later page", () => {
    const big = [{ path: "big.ts", lines: Array.from({ length: 2000 }, (_, index) => add(`line(${index});`)).concat(del("old();")) }];
    const markup = html({ files: big });
    expect(rowNumbers(markup)).toHaveLength(400);
    expect(text(markup)).toContain("Show 400 more lines");

    const marked = html({ files: big, mark: { path: "big.ts", line: 900 } });
    expect(rowNumbers(marked)).toHaveLength(1200);
    expect(text(marked)).toContain("Show 400 more lines");
    expect(rowNumbers(html({ files: big, mark: { path: "big.ts", line: 1, side: "old" } }))).toHaveLength(2001);
  });

  test("escapes source text", () => {
    const markup = html({ files: [{ path: "x.txt", lines: [del("<script>alert(1)</script>"), add("<img src=x onerror=alert(1)>")] }] });
    expect(markup).not.toContain("<script>alert");
    expect(markup).not.toContain("<img src=x");
    expect(markup).toContain("&lt;script&gt;");
  });

  test("a toolbar leads the file row and stays, with the file names, while the code loads or fails", () => {
    for (const status of [undefined, "loading", "error"] as const) {
      const markup = html({ files, status, toolbarStart: "Compare with", onRetry: () => {} });
      const start = markup.indexOf('class="k2b-code-diff__toolbar"');
      expect(start).toBeGreaterThan(-1);
      expect(start).toBeLessThan(markup.indexOf('role="tablist"'));
      expect(text(markup)).toContain("Compare with");
      expect(markup).toContain('role="tabpanel"');
      expect(markup.match(/role="tab"/g)).toHaveLength(3);
    }
    const single = html({ files: [files[0]!], status: "loading", toolbarStart: "Compare with" });
    expect(single.indexOf("k2b-code-diff__toolbar")).toBeLessThan(single.indexOf("k2b-code-diff__file"));
    expect(single).toContain('aria-busy="true"');
    // Without a toolbar nothing is added.
    expect(html({ files })).not.toContain("k2b-code-diff__toolbar");
  });

  test("the code surface is a keyboard stop, and TypeScript is highlighted by the stdlib preset", () => {
    const markup = html({ files: [{ path: "index.ts", lines: [add("const answer = 42; // note")] }] });
    expect(markup).toMatch(/class="k2b-code-diff__body" role="region"[^>]*tabindex="0"/);
    expect(markup).toContain('<span class="hl-keyword">const</span>');
    expect(markup).toContain('<span class="hl-comment">// note</span>');
  });

  test("unchanged code keeps the surface as one quiet state", () => {
    const empty = html({ files: [files[2]!], toolbarStart: "Compare with" });
    expect(empty).toMatch(/class="k2b-code-diff__state"><div[^>]*data-state="empty"/);
    expect(text(empty)).toContain("Compare with");
  });
  describe("line actions and content below a line", () => {
    const lineAction = { label: ({ line }: { line: number }) => `Comment on line ${line}`, onSelect: () => {} };
    const lineSlot = ({ path, line }: { path: string; line: number }) => `Thread ${path}:${line}`;
    const slotRow = (markup: string) => [...markup.matchAll(/data-row="(\d+)"[^>]*data-noted="true"/g)].map((match) => Number(match[1]));

    test("puts one action on every line of the new version, in a fixed place, and none on removed lines", () => {
      const markup = html({ files, lineAction });
      expect(markup).toContain('data-annotated="true"');
      // Nine visible rows, one removed: eight actions, named by the new line number.
      expect(markup.match(/class="k2b-code-diff__action ?"/g)).toHaveLength(8);
      expect(markup).toContain('aria-label="Comment on line 13"');
      expect(markup).not.toMatch(/data-kind="del"(?:(?!data-row=).)*k2b-code-diff__action/s);
      // One tab stop for the code: the first action; the region itself leaves the tab order.
      expect(markup.match(/k2b-code-diff__action[^>]*tabindex="0"/gi)).toHaveLength(1);
      expect(markup).toMatch(/class="k2b-code-diff__body" role="region"[^>]*tabindex="-1"/);
      // Without the props nothing changes.
      expect(html({ files })).not.toContain("k2b-code-diff__gutter");
    });

    test("a listed line is marked, tinted, shows its content directly below and never folds away", () => {
      // New line 3 sits inside the fold of rows 0–8.
      const markup = html({ files, lineAction, lineSlot, slotLines: [{ path: "index.ts", line: 3 }] });
      expect(slotRow(markup)).toEqual([2]);
      expect(markup).toContain("k2b-code-diff__noted");
      const row = markup.indexOf('data-row="2"');
      const slot = markup.indexOf('class="k2b-code-diff__slot"');
      expect(slot).toBeGreaterThan(row);
      expect(slot).toBeLessThan(markup.indexOf('data-row="9"'));
      expect(text(markup)).toContain("Thread index.ts:3");
      // The fold splits around the kept line.
      expect(text(markup)).toContain("2 unchanged lines");
      expect(text(markup)).toContain("6 unchanged lines");
      // Another file's lines do not show here.
      expect(html({ files, lineSlot, slotLines: [{ path: "params.ts", line: 2 }] })).not.toContain("k2b-code-diff__slot");
    });

    test("an unchanged file shows a note and only its listed lines with their content", () => {
      const markup = html({ files: [files[2]!], lineAction, lineSlot, slotLines: [{ path: "params.ts", line: 2 }] }, "de");
      expect(markup).not.toContain('data-state="empty"');
      expect(text(markup)).toContain("Diese Datei ist unverändert. Unten stehen die kommentierten Zeilen.");
      expect(rowNumbers(markup)).toEqual([1]);
      expect(text(markup)).toContain("Thread params.ts:2");
      expect(markup).not.toContain("k2b-code-diff__fold");
    });

    test("whole code has number, place and code; a listed line on a later page renders its page", () => {
      const big = [{ path: "big.ts", lines: Array.from({ length: 1000 }, (_, index) => add(`line(${index});`)) }];
      const markup = html({ files: big, lineAction, lineSlot, slotLines: [{ path: "big.ts", line: 700 }] });
      expect(markup).toContain('data-whole="true"');
      expect(rowNumbers(markup)).toHaveLength(800);
      expect(text(markup)).toContain("Thread big.ts:700");
    });
  });
});
