import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { showcaseDashboards } from "../dashboards";
import { resolveDrawing } from "../resolve";
import { specToTsx } from "../tsx";
import { chartShowcaseExamples, chartShowcaseKinds, chartShowcaseQuestions } from ".";

const support = new Set(["index.ts", "types.ts", "common.ts"]);

test("every example file is listed in the registry", () => {
  const index = readFileSync(resolve(import.meta.dir, "index.ts"), "utf8");
  const files = readdirSync(import.meta.dir).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && !support.has(file));
  expect(files.length).toBeGreaterThanOrEqual(14);
  for (const file of files) expect(index, `${file} is missing in examples/index.ts`).toContain(`from "./${file.replace(/\.ts$/, "")}"`);
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
    forecast: { from: 2 },
  });
  expect(unknown).toMatchObject({ mode: "slot", kind: "line" });
  expect(resolveDrawing({ kind: "sankey", title: "Flows", nodes: [], links: [] })).toMatchObject({ mode: "slot", kind: "sankey" });
  expect(resolveDrawing({ block: "budget", items: [] })).toMatchObject({ mode: "slot", kind: "budget" });
});

test("TSX is generated from the same description as the JSON", () => {
  for (const example of chartShowcaseExamples) {
    const tsx = specToTsx(example.spec);
    const spec = example.spec as Record<string, unknown>;
    expect(tsx).toContain(`kind=${JSON.stringify(spec.kind)}`);
    for (const key of Object.keys(spec).filter((key) => key !== "kind"))
      expect(tsx, `${example.id}.${key}`).toMatch(new RegExp(`\\n  ${key}(=|\\n)`));
  }
});

test("dashboard panels have unique ids and say what each slot stands for", () => {
  for (const dashboard of showcaseDashboards) {
    const ids = dashboard.sections.flatMap((section) => section.panels.map((panel) => panel.id));
    expect(new Set(ids).size, dashboard.slug).toBe(ids.length);
    for (const panel of dashboard.sections.flatMap((section) => section.panels)) expect(panel.intended.length, panel.id).toBeGreaterThan(0);
  }
});
