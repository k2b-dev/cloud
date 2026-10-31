import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

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
const text = (markup: string) => markup.replace(/<[^>]+>/g, "").replace(/&#39;/g, "'");
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
    expect(text(markup)).toContain("index.ts+2 −1");
    expect(text(markup)).toContain("reply.test.ts+1 −1");
    expect(text(markup)).toContain("params.tsgleich");
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
    expect(text(markup)).toContain("index.ts17 Zeilen");
    expect(markup).toContain('aria-label="Code-Unterschied, nur lesen · index.ts, neue Datei"');
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
    expect(text(loading)).toContain("Loading the code difference");

    const failed = html({ files, status: "error", errorDescription: "Nothing was decided.", onRetry: () => {} }, "de");
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("ti ti-cloud-off");
    expect(text(failed)).toContain("Der Code-Unterschied konnte nicht geladen werden");
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
});
