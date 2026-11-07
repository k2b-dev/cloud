import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { exampleFiles, isExampleList } from "./files";
import { writeExampleRegistry } from "./generate";

// Like every Fibel start and build: lanes add example files on main without touching the generated list.
writeExampleRegistry();
const { showcaseDashboards } = await import("../dashboards");
const { resolveDrawing } = await import("../resolve");
const { specToTsx } = await import("../tsx");
const { chartShowcaseExamples, chartShowcaseKinds, chartShowcaseQuestions } = await import(".");

test("every example file in the folder reaches the registry", () => {
  expect(exampleFiles().length).toBeGreaterThanOrEqual(14);
  for (const file of exampleFiles()) {
    const module = require(resolve(import.meta.dir, file)) as Record<string, unknown>;
    const examples = Object.values(module).filter(isExampleList).flat();
    expect(examples.length, file).toBeGreaterThan(0);
    for (const example of examples)
      expect(
        chartShowcaseExamples.some((entry) => entry.id === example.id),
        `${file}: ${example.id}`,
      ).toBe(true);
  }
});

test("examples have unique URL-safe ids, a known question and complete guidance", () => {
  const ids = chartShowcaseExamples.map((example) => example.id);
  expect(new Set(ids).size).toBe(ids.length);
  const questions = new Set(chartShowcaseQuestions.map((question) => question.id));
  for (const example of chartShowcaseExamples) {
    expect(example.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(questions.has(example.question), example.id).toBe(true);
    for (const list of [example.useFor, example.avoidFor, example.a11y, example.options])
      expect(list.length, example.id).toBeGreaterThan(0);
  }
  expect(new Set(chartShowcaseKinds.map((kind) => kind.slug)).size).toBe(chartShowcaseKinds.length);
});

test("every example of a kind that exists today draws, never as a slot", () => {
  for (const example of chartShowcaseExamples) {
    const drawing = resolveDrawing(example.spec);
    expect(drawing.mode, example.id).not.toBe("slot");
    if (drawing.mode === "snapshot") {
      expect(drawing.snapshot.marks.length, example.id).toBeGreaterThan(0);
      // Every mark, the first one too, names its values in the tooltip.
      for (const mark of drawing.snapshot.marks) expect(mark.tooltip.rows.length, `${example.id} ${mark.key}`).toBeGreaterThan(0);
      expect(drawing.rows.length, example.id).toBeGreaterThan(0);
    }
    if (drawing.mode === "live") expect(drawing.rows.length, example.id).toBeGreaterThan(0);
  }
});

test("a description with an option this build does not know becomes a slot instead of a smaller chart", () => {
  const known = resolveDrawing({
    kind: "line",
    title: "Balance",
    series: [
      {
        data: [
          { x: 1, y: 2 },
          { x: 2, y: 3 },
        ],
      },
    ],
  });
  expect(known.mode).toBe("snapshot");
  const unknown = resolveDrawing({
    kind: "line",
    title: "Balance",
    series: [
      {
        data: [
          { x: 1, y: 2 },
          { x: 2, y: 3 },
        ],
      },
    ],
    notAnOption: true,
  });
  expect(unknown).toMatchObject({ mode: "slot", kind: "line" });
  expect(resolveDrawing({ kind: "notAKind", title: "Flows", nodes: [] })).toMatchObject({ mode: "slot", kind: "notAKind" });
  expect(resolveDrawing({ block: "notABlock", items: [] })).toMatchObject({ mode: "slot", kind: "notABlock" });
});

test("every showcase page has non-empty TSX and JSON, generated from the same description", () => {
  for (const example of chartShowcaseExamples) {
    const tsx = specToTsx(example.spec);
    const json = JSON.stringify(example.spec, null, 2);
    // Both code views of every kind page, blocks included, show real code.
    expect(tsx.split("\n").length, `${example.id} TSX`).toBeGreaterThan(3);
    expect(tsx, `${example.id} TSX`).toMatch(/^import \{ [A-Za-z, ]+ \} from "@k2b\/ui";\n\n(<[A-Z>]|\/\/ )/);
    expect(json.length, `${example.id} JSON`).toBeGreaterThan(2);
    const spec = example.spec as Record<string, unknown>;
    // Blocks keep their content: one tile per key figure, one amount per flow entry, the table's columns and rows.
    if (Array.isArray(example.spec)) {
      expect(tsx.match(/<FlowAmount\n/g)?.length, example.id).toBe(example.spec.length);
      expect(tsx.endsWith("</>"), example.id).toBe(true);
      continue;
    }
    if (spec.block === "stats") {
      expect(tsx.match(/<StatCell\n/g)?.length, example.id).toBe((spec.items as unknown[]).length);
      expect(tsx.endsWith("</StatGrid>"), example.id).toBe(true);
      continue;
    }
    if (spec.block === "table") {
      for (const key of ["columns={", "rows={", "ariaLabel="]) expect(tsx, `${example.id} ${key}`).toContain(key);
      for (const column of spec.columns as { id: string }[]) expect(tsx, `${example.id} ${column.id}`).toContain(`value: "${column.id}"`);
      continue;
    }
    if (typeof spec.block === "string") {
      for (const key of Object.keys(spec).filter((key) => !["block", "title", "subtitle"].includes(key)))
        expect(tsx, `${example.id}.${key}`).toMatch(new RegExp(`\\n  ${key}(=|\\n)`));
      continue;
    }
    // A kind with a typed component reads as Chart.Kind (F7); otherwise as the dispatcher with kind.
    expect(tsx).toMatch(
      new RegExp(`<Chart\\.${String(spec.kind)[0]!.toUpperCase()}${String(spec.kind).slice(1)}\\n|kind=${JSON.stringify(spec.kind)}`),
    );
    for (const key of Object.keys(spec).filter((key) => key !== "kind"))
      expect(tsx, `${example.id}.${key}`).toMatch(new RegExp(`\\n  ${key}(=|\\n)`));
  }
  expect(specToTsx({ kind: "line", title: "A", series: [] })).toContain("<Chart.Line");
  // Blocks read as the components that draw them.
  expect(specToTsx({ block: "budget", currency: "EUR", items: [] })).toContain("<BudgetList");
  expect(specToTsx({ block: "balance", start: 1, in: 2, out: 3, currency: "EUR" })).toContain("<BalanceSummary");
  expect(specToTsx([{ type: "flow", value: 1, currency: "EUR" }])).toContain("<FlowAmount");
  expect(specToTsx({ block: "table", columns: [{ id: "a", label: "A" }], rows: [] })).toContain("<DataTable");
});

test("dashboard panels have unique ids and say what each slot stands for", () => {
  for (const dashboard of showcaseDashboards) {
    const ids = dashboard.sections.flatMap((section) => section.panels.map((panel) => panel.id));
    expect(new Set(ids).size, dashboard.slug).toBe(ids.length);
    for (const panel of dashboard.sections.flatMap((section) => section.panels)) expect(panel.intended.length, panel.id).toBeGreaterThan(0);
  }
});
