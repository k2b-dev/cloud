import { describe, expect, test } from "bun:test";
import { ChangeSet } from "@codemirror/state";
import { GFM, parser } from "@lezer/markdown";
import * as Y from "yjs";
import * as T from "./markdown-table";

const table = (doc: string): T.Table => {
  const result = T.findTables(doc);
  expect(result).toHaveLength(1);
  return result[0]!;
};
const grid = (doc: string) =>
  table(doc)
    .lines.filter((_, i) => i !== 1)
    .map((line) => line.cells.map((cell) => T.displayCell(cell.text)));
const edit = (raw: string, next: string) => T.applyChanges(raw, T.cellChanges(raw, next, 0));

describe("Lezer GFM table boundaries", () => {
  test("only top-level tables, excluding code, quotes and list markers", () => {
    const source = "| h |\n| --- |\n| x |";
    const excluded = [
      `\`\`\`md\n${source}\n\`\`\``,
      `~~~~\n${source}\n~~~~`,
      source
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n"),
      source
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n"),
      `- | h |\n  | --- |\n  | x |`,
      `1. | h |\n   | --- |\n   | x |`,
    ];
    for (const doc of excluded) expect(T.findTables(doc)).toEqual([]);
    const doc = [...excluded, source, "after"].join("\n\n");
    expect(table(doc).from).toBe(doc.lastIndexOf(source));
    expect(doc.slice(table(doc).from, table(doc).to)).toBe(source);
  });

  test("prose, HTML blocks, malformed delimiters and mismatched headers remain raw", () => {
    for (const doc of ["a | b\n- prose | ---", "a | b\n--- |", "| |\n| : |", "<pre>\n| h |\n| --- |\n</pre>"])
      expect(T.findTables(doc)).toEqual([]);
  });

  test("GFM boundary agrees with Lezer, including body lines without pipes", () => {
    const doc = "before\n\n  a | b\n --- | :---:\nx\ny | z | extra\n\n# end";
    const result = table(doc);
    expect(result.from).toBe(doc.indexOf("  a"));
    expect(result.align).toEqual([null, "center"]);
    expect(result.lines.map((line) => line.cells.length)).toEqual([2, 2, 1, 3]);
    expect(T.rowCount(result)).toBe(3);
    const tree = parser.configure(GFM).parse(doc);
    const node = tree.topNode.getChild("Table")!;
    expect(result.to).toBe(node.to);
    expect(T.tableAt(doc, result.to)).toEqual(result);
    expect(T.tableAt(doc, result.to + 1)).toBeNull();
  });

  test("original CRLF/CR offsets and every untouched byte survive", () => {
    for (const newline of ["\n", "\r\n", "\r"]) {
      const doc = ["before", "", "  | h |", "  | --- |", "  | x |", "", "after"].join(newline);
      const result = table(doc),
        cell = T.gridLine(result, 1)!.cells[0]!;
      expect(doc.slice(cell.from, cell.to)).toBe("x");
      expect(T.applyChanges(doc, T.cellChanges(cell.text, "xy", cell.from))).toBe(doc.replace("| x |", "| xy |"));
      const appended = T.applyChanges(doc, T.insertRow(result, 1));
      expect(appended).toBe(doc.replace(`  | x |${newline}`, `  | x |${newline}|   |${newline}`));
      expect(T.applyChanges(doc, T.deleteRow(result, 1))).toBe(doc.replace(`${newline}  | x |`, ""));
    }
  });
});

describe("literal display/source mapping", () => {
  test("every backslash parity before a pipe, and literal trailing slashes", () => {
    for (let n = 0; n < 12; n++) {
      const literal = "\\".repeat(n) + "|" + "\\".repeat(n);
      expect(T.displayCell(T.escapeCell(literal))).toBe(literal);
      const doc = `| h |\n| --- |\n| ${T.escapeCell(literal)} |`;
      expect(grid(doc)[1]).toEqual([literal]);
      const raw = "\\".repeat(n) + "|";
      expect(T.displayCell(raw)).toBe("\\".repeat(Math.floor(n / 2)) + "|");
    }
  });

  test("unescaped pipes follow backslash parity when splitting cells", () => {
    for (let n = 0; n < 8; n++) {
      const doc = `| a | b |\n| --- | --- |\n| x${"\\".repeat(n)}| y |`;
      expect(T.gridLine(table(doc), 1)!.cells).toHaveLength(n % 2 ? 1 : 2);
    }
  });

  test("a typed character is an insertion; untouched noncanonical escapes remain byte-identical", () => {
    const raw = String.raw`a\*b\|c\\d\q`;
    expect(T.cellChanges(raw, T.displayCell(raw), 13)).toEqual([]);
    expect(T.cellChanges(raw, T.displayCell(raw) + "!", 13)).toEqual([{ from: 13 + raw.length, to: 13 + raw.length, insert: "!" }]);
    expect(edit(raw, "A" + T.displayCell(raw).slice(1))).toBe("A" + raw.slice(1));
    expect(T.cellChanges(String.raw`x\|y`, "x|Zy", 4)).toEqual([{ from: 7, to: 7, insert: "Z" }]);
    expect(T.cellDisplayMap(String.raw`x\\\|y`)).toEqual({ text: "x\\|y", offsets: [0, 1, 3, 5, 6] });
  });

  test("cell replacements keep whole Unicode characters through the Yjs write seam", () => {
    for (const [before, after] of [
      ["😀", "😁"],
      ["😀", "🨀"],
      ["a😀b", "a😁b"],
      ["😀😀", "😁😀"],
      ["😀", ""],
    ] as const) {
      const doc = new Y.Doc();
      doc.clientID = 101;
      const text = doc.getText("codemirror");
      const prefix = "| A |\n| --- |\n| ";
      text.insert(0, prefix + before + " |");
      try {
        const changes = T.cellChanges(before, after, prefix.length);
        doc.transact(() => {
          for (const change of [...changes].reverse()) {
            if (change.to > change.from) text.delete(change.from, change.to - change.from);
            if (change.insert) text.insert(change.from, change.insert);
          }
        });
        expect(text.toString()).toBe(prefix + after + " |");
        expect(text.toString().isWellFormed()).toBe(true);
      } finally {
        doc.destroy();
      }
    }
  });

  test("inserts, deletes and replacements beside old lone slashes roundtrip", () => {
    const raws = ["", "abc", String.raw`\x`, String.raw`\*`, String.raw`a\\\|b`, "x\\", "x\\\\", "😀\\q"];
    for (const raw of raws) {
      const shown = T.displayCell(raw);
      for (let from = 0; from <= shown.length; from++) {
        for (let to = from; to <= shown.length; to++) {
          for (const inserted of ["", "x", "|", "\\", "\\|", "|\\", "\\\\|", "\r\n", "\r", "\u2028"]) {
            const next = shown.slice(0, from) + inserted + shown.slice(to);
            expect(T.displayCell(edit(raw, next))).toBe(next.replace(/\r\n|[\r\n\u2028\u2029]/g, " "));
          }
        }
      }
    }
  });

  test("editing beside a lone slash cannot expose a structural pipe or closing delimiter", () => {
    const cases: [string, string][] = [
      [String.raw`\q`, String.raw`\|`],
      [String.raw`\a\|`, String.raw`\|`],
      [String.raw`\q`, "\\"],
    ];
    for (const [raw, next] of cases) {
      const doc = `|h|\n|-|\n|${raw}|`;
      const cell = T.gridLine(table(doc), 1)!.cells[0]!;
      const changed = T.applyChanges(doc, T.cellChanges(cell.text, next, cell.from));
      expect(grid(changed)[1]).toEqual([next]);
      expect(T.gridLine(table(changed), 1)!.trailingPipe).toBe(true);
    }
  });

  test("line breaks normalize on insertion and literal escapes are never interpreted twice", () => {
    const literal = String.raw`\|` + "\r\nnext\rline\nend";
    expect(T.escapeCell(literal)).toBe(String.raw`\\\| next line end`);
    expect(T.displayCell(edit("", literal))).toBe(String.raw`\| next line end`);
  });

  test("mapped changes preserve intervening remote insertions", () => {
    const raw = "abcdef";
    const remote = ChangeSet.of([{ from: 2, insert: "REMOTE" }], raw.length);
    const current = "abREMOTEcdef";
    const changes = T.mappedCellChanges(raw, "aZf", 0, remote.desc);
    expect(T.applyChanges(current, changes)).toBe("aZREMOTEf");
  });

  test("mapped deletion excludes remote replacements and tracks deleted base identities", () => {
    const raw = "abcdef";
    const remote = ChangeSet.of([{ from: 2, to: 4, insert: "REMOTE" }], raw.length);
    const current = "abREMOTEef";
    expect(T.applyChanges(current, T.mappedCellChanges(raw, "af", 0, remote.desc))).toBe("aREMOTEf");
    const deleted = ChangeSet.of([{ from: 0, to: raw.length }], raw.length);
    expect(T.mappedCellChanges(raw, "", 0, deleted.desc)).toEqual([]);
    expect(T.applyChanges("", T.mappedCellChanges(raw, "Z", 0, deleted.desc))).toBe("Z");
  });
});

describe("minimal structural operations", () => {
  test("cell edits keep all padding, empty-cell whitespace, and surrounding bytes", () => {
    const doc = "prefix\n\n|  A  |\t B\t|    |\n| --- | --- | --- |\n| x | y | z |\n\nsuffix";
    const result = table(doc);
    expect(T.applyChanges(doc, T.setCellText(result, 0, 0, "AA"))).toBe(doc.replace("  A  ", "  AA  "));
    const empty = result.lines[0]!.cells[2]!;
    expect(T.cellChanges(empty.text, "", empty.from)).toEqual([]);
    const changes = T.setCellText(result, 0, 2, T.escapeCell("|\\"));
    expect(changes).toEqual([{ from: empty.from, to: empty.from, insert: T.escapeCell("|\\") }]);
    expect(T.applyChanges(doc, changes)).toBe(doc.slice(0, empty.from) + T.escapeCell("|\\") + doc.slice(empty.from));
  });

  test("edits a missing ragged cell without erasing extra body cells", () => {
    const doc = "| a | b | c |\n| - | - | - |\n| x |\n| y | z | q | EXTRA |";
    const result = table(doc);
    const next = T.applyChanges(doc, T.setCellText(result, 1, 2, T.escapeCell("p|\\")));
    expect(grid(next)).toEqual([
      ["a", "b", "c"],
      ["x", "", "p|\\"],
      ["y", "z", "q", "EXTRA"],
    ]);
    expect(next).toContain("| y | z | q | EXTRA |");
    const extended = T.applyChanges(doc, T.insertColumn(result, 2));
    expect(grid(extended)).toEqual([
      ["a", "b", "", "c"],
      ["x", "", ""],
      ["y", "z", "", "q", "EXTRA"],
    ]);
  });

  test("insert and delete first/middle/last columns with every outer-pipe convention", () => {
    for (const [left, right] of [
      ["|", "|"],
      ["", ""],
      ["|", ""],
      ["", "|"],
    ]) {
      const doc = `${left} a | b | c ${right}\n${left} --- | :---: | ---: ${right}\n${left} x | y | z ${right}`;
      for (let col = 0; col <= 3; col++) {
        const next = T.applyChanges(doc, T.insertColumn(table(doc), col));
        const expected = ["a", "b", "c"];
        expected.splice(col, 0, "");
        expect(grid(next)[0]).toEqual(expected);
        const undone = T.applyChanges(next, T.deleteColumn(table(next), col));
        expect(grid(undone)).toEqual(grid(doc));
        // An outer pipe added to represent an edge empty cell remains explicit.
        if (left && right) expect(undone).toBe(doc);
      }
      for (let col = 0; col < 3; col++) {
        const next = T.applyChanges(doc, T.deleteColumn(table(doc), col));
        expect(grid(next)[0]).toEqual(["a", "b", "c"].filter((_, i) => i !== col));
        expect(grid(next)[1]).toEqual(["x", "y", "z"].filter((_, i) => i !== col));
      }
    }
  });

  test("deleting the only ragged body cell cannot orphan later rows", () => {
    for (const short of ["x", "x |", "| x", "| x |"]) {
      const doc = `| a | b |\n| --- | --- |\n${short}\n| keep | extra | surplus |`;
      const next = T.applyChanges(doc, T.deleteColumn(table(doc), 0));
      expect(grid(next)).toEqual([["b"], [""], ["extra", "surplus"]]);
    }
  });

  test("deleting either of two columns keeps a valid single-column table", () => {
    for (const [left, right] of [
      ["|", "|"],
      ["", ""],
      ["|", ""],
      ["", "|"],
    ]) {
      const doc = `${left} a | b ${right}\n${left} --- | --- ${right}\n${left} x | y ${right}`;
      for (const col of [0, 1]) {
        const next = T.applyChanges(doc, T.deleteColumn(table(doc), col));
        expect(grid(next)).toEqual(col === 0 ? [["b"], ["y"]] : [["a"], ["x"]]);
      }
    }
  });

  test("appending to a ragged table pads header when appending beyond extra cells", () => {
    const doc = "| a |\n| - |\n| x | y | z |";
    const next = T.applyChanges(doc, T.insertColumn(table(doc), 3));
    expect(grid(next)).toEqual([
      ["a", "", "", ""],
      ["x", "y", "z", ""],
    ]);
    const deleted = T.applyChanges(doc, T.deleteColumn(table(doc), 2));
    expect(grid(deleted)).toEqual([["a"], ["x", "y"]]);
    expect(T.deleteColumn(table(doc), 0)).toEqual([]);
  });

  test("new rows follow the delimiter/header or last body row and leave neighbours intact", () => {
    for (const suffix of ["", "\n", "\n\nnext"]) {
      const doc = "| h |\n| --- |" + suffix;
      const next = T.applyChanges(doc, T.insertRow(table(doc), 0));
      expect(next).toBe("| h |\n| --- |\n|   |" + suffix);
      expect(T.applyChanges(next, T.deleteRow(table(next), 1))).toBe(doc);
      expect(T.deleteRow(table(next), 0)).toEqual([]);
    }
    const doc = "a | b\n--- | ---\nx | y\n\nend";
    expect(T.applyChanges(doc, T.insertRow(table(doc), 1))).toBe("a | b\n--- | ---\nx | y\n|   |   |\n\nend");
  });

  test("alignment changes only colon markers", () => {
    const doc = "| h |\n|  -----  |\n| x |";
    let next = T.applyChanges(doc, T.setAlign(table(doc), 0, "center"));
    expect(next).toBe("| h |\n|  :-----:  |\n| x |");
    next = T.applyChanges(next, T.setAlign(table(next), 0, "right"));
    expect(next).toBe("| h |\n|  -----:  |\n| x |");
    expect(T.setAlign(table(next), 0, "right")).toEqual([]);
    expect(T.applyChanges(next, T.setAlign(table(next), 0, null))).toBe(doc);
  });

  test("invalid indices are no-ops; overlapping or out-of-source edits are refused", () => {
    const result = table("| h |\n| - |");
    for (const invalid of [-1, 0.5, NaN, Infinity]) {
      expect(T.insertColumn(result, invalid)).toEqual([]);
      expect(T.deleteColumn(result, invalid)).toEqual([]);
      expect(T.setCellText(result, 0, invalid, "x")).toEqual([]);
      expect(T.insertRow(result, invalid)).toEqual([]);
      expect(T.deleteRow(result, invalid)).toEqual([]);
      expect(T.setAlign(result, invalid, null)).toEqual([]);
    }
    expect(T.insertColumn(result, 2)).toEqual([]);
    expect(T.setCellText(result, 0, Number.MAX_SAFE_INTEGER, "x")).toEqual([]);
    expect(T.insertRow(result, 2)).toEqual([]);
    expect(() => T.applyChanges("abc", [{ from: 1, to: 4, insert: "" }])).toThrow(RangeError);
    expect(() =>
      T.applyChanges("abc", [
        { from: 0, to: 2, insert: "" },
        { from: 1, to: 3, insert: "" },
      ]),
    ).toThrow(RangeError);
  });
});

describe("clipboard grids", () => {
  test("quoted TSV, escaped quotes, embedded newlines, empty cells and CRLF", () => {
    expect(T.parseTsv('a\t"b\tq"\t\r\n"x\n y"\t"say ""hi"""\tlast\r\n')).toEqual([
      ["a", "b\tq", ""],
      ["x\n y", 'say "hi"', "last"],
    ]);
    expect(T.parseTsv("\t\n\t")).toEqual([
      ["", ""],
      ["", ""],
    ]);
    expect(T.parseTsv('a\t""')).toEqual([["a", ""]]);
    expect(T.parseTsv("plain text")).toBeNull();
    expect(T.parseTsv('a\t"unfinished')).toBeNull();
    expect(T.parseTsv('a\t"closed"suffix')).toBeNull();
  });

  test("grid generation pads short rows, preserves extra cells and escapes literals once", () => {
    const values = [["A", "B"], ["x|y", "\\|", "extra"], ["only"], ["multi\r\nline"]];
    const source = T.tableFromGrid(values);
    expect(grid(source)).toEqual([
      ["A", "B", ""],
      ["x|y", "\\|", "extra"],
      ["only", "", ""],
      ["multi line", "", ""],
    ]);
    expect(T.tableFromGrid([])).toBe("|  |\n| --- |");
    expect(table(T.tableFromGrid([])).columns).toBe(1);
    expect(T.tableFromGrid([["  space  "]])).toContain("|   space   |");
  });

  test("model has no silent clipboard cap or spread-argument limit", () => {
    const values = Array.from({ length: 2100 }, (_, i) => [String(i)]);
    const source = T.tableFromGrid(values);
    expect(T.rowCount(table(source))).toBe(2100);
    expect(T.parseTsv(Array.from({ length: 2100 }, () => "a\tb").join("\n"))).toHaveLength(2100);
  });
});

test("complete columns preserves every cell and surrounding source", () => {
  const source = "Before\r\n\r\n| A | B |\r\n| --- | --- |\r\n| x | y | EXTRA |\r\n| short |\r\n\r\nAfter";
  const value = T.findTables(source)[0]!;
  const changed = T.applyChanges(source, T.completeColumns(value));
  expect(changed).toContain("| x | y | EXTRA |");
  expect(changed.startsWith("Before\r\n\r\n")).toBe(true);
  expect(changed.endsWith("\r\n\r\nAfter")).toBe(true);
  const next = T.findTables(changed)[0]!;
  expect(next.columns).toBe(3);
  expect(next.lines.every((line) => line.cells.length === 3)).toBe(true);
  expect(T.completeColumns(next)).toEqual([]);
});

test("repair settles surviving peer text after an appended row is undone, without rewriting any source", () => {
  const source = "Before\n\n| A | B |\n| --- | --- |\n| one | two |peer😀\\\n\nAfter";
  const changes = T.repairTables(source, 2_097_152);
  expect(changes.every((change) => change.from === change.to)).toBe(true);
  const result = T.applyChanges(source, changes);
  const table = T.findTables(result)[0]!;
  expect(table.columns).toBe(3);
  expect(table.lines.every((line) => line.cells.length === 3 && line.trailingPipe)).toBe(true);
  expect(result).toContain("| one | two |peer😀\\ |");
  expect(result.startsWith("Before\n\n")).toBe(true);
  expect(result.endsWith("\n\nAfter")).toBe(true);
  expect(T.repairTables(result, 2_097_152)).toEqual([]);
});

test("repair leaves valid omitted pipes, formulas, fenced code, quotes and unrecognized damage unchanged", () => {
  for (const source of [
    "A | B\n--- | ---\nx | =A1+1",
    "```md\n| A | B |\n| --- | --- |\n| x | y | extra |\n```",
    "> | A | B |\n> | --- | --- |\n> | x | y | extra |",
    "    | A | B |\n    | --- | --- |\n    | x | y | extra |",
    "| A | B |\n| --- | BROKEN --- |\n| keep | all |",
  ])
    expect(T.repairTables(source, 2_097_152)).toEqual([]);
});

test("repair counts quadratic grid padding before allocation and leaves over-budget damage visible", () => {
  const source = "| A | B |\n| --- | --- |\n" + "|x".repeat(100) + "|\n" + "x\n".repeat(100);
  expect(source.length).toBeLessThan(4096);
  expect(T.repairTables(source, 4096)).toEqual([]);
  const changes = T.repairTables(source, 100_000);
  const expanded = T.applyChanges(source, changes);
  expect(expanded.length).toBeGreaterThan(4096);
  expect(T.repairTables(source, expanded.length)).toEqual(changes);
  expect(T.repairTables(source, expanded.length - 1)).toEqual([]);
});
