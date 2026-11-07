import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { showcaseDashboards } from "../dashboards";
import { resolveDrawing } from "../resolve";
import { specToTsx } from "../tsx";
import { chartShowcaseExamples, chartShowcaseKinds, chartShowcaseQuestions } from ".";
import { exampleFiles, isExampleList } from "./files";
import { exampleRegistrySource } from "./generate";

test("every example file in the folder is in the generated registry", () => {
  expect(exampleFiles().length).toBeGreaterThanOrEqual(14);
  expect(
    readFileSync(resolve(import.meta.dir, "registry.generated.ts"), "utf8"),
    "run: bun docs-site/src/ui/demo-sections/charts/examples/generate.ts",
  ).toBe(exampleRegistrySource());
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
  const unknown = resolveDrawing({ kind: "line", title: "Balance", series: [{ data: [{ x: 1, y: 2 }, { x: 2, y: 3 }] }], notAnOption: true });
  expect(unknown).toMatchObject({ mode: "slot", kind: "line" });
  expect(resolveDrawing({ kind: "notAKind", title: "Flows", nodes: [] })).toMatchObject({ mode: "slot", kind: "notAKind" });
  expect(resolveDrawing({ block: "notABlock", items: [] })).toMatchObject({ mode: "slot", kind: "notABlock" });
});
  expect(unknown).toMatchObject({ mode: "slot", kind: "line" });
  expect(resolveDrawing({ kind: "sankey", title: "Flows", nodes: [], links: [] })).toMatchObject({ mode: "slot", kind: "sankey" });
  expect(resolveDrawing({ block: "budget", items: [] })).toMatchObject({ mode: "slot", kind: "budget" });
});

test("TSX is generated from the same description as the JSON", () => {
  for (const example of chartShowcaseExamples) {
    const tsx = specToTsx(example.spec);
    const spec = example.spec as Record<string, unknown>;
    // Blocks other than key figures are drawn by their own components; their portable form is the JSON alone.
    if (Array.isArray(example.spec) || (typeof spec.block === "string" && spec.block !== "stats")) {
      expect(tsx, example.id).toBe("");
      continue;
    }
    if (spec.block === "stats") {
      expect(tsx, example.id).toContain("<StatGrid");
      expect(tsx.match(/<StatCell/g)?.length, example.id).toBe((spec.items as unknown[]).length);
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
});

test("dashboard panels have unique ids and say what each slot stands for", () => {
  for (const dashboard of showcaseDashboards) {
    const ids = dashboard.sections.flatMap((section) => section.panels.map((panel) => panel.id));
    expect(new Set(ids).size, dashboard.slug).toBe(ids.length);
    for (const panel of dashboard.sections.flatMap((section) => section.panels)) expect(panel.intended.length, panel.id).toBeGreaterThan(0);
  }
});
