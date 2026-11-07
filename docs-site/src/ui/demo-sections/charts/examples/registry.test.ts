import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { exampleFiles, isExampleList } from "./files";
import { writeExampleRegistry } from "./generate";

// Like every Fibel start and build: lanes add example files on main without touching the generated list.
writeExampleRegistry();
const { showcaseDashboards } = await import("../dashboards");
const { resolveDrawing } = await import("../resolve");
const { specToTsx } = await import("../tsx");
const { GUIDANCE_LIMIT, kindGuidance, schemaValues } = await import("../guidance");
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

test("a dashboard panel draws as soon as an example with its kind, layout and options draws", () => {
  // A slot only waits for a kind or option this build lacks; a mistake in the panel's own data must not hide it.
  const fields = (spec: unknown) =>
    spec !== null && typeof spec === "object" && !Array.isArray(spec) ? (spec as Record<string, unknown>) : {};
  const drawn = chartShowcaseExamples
    .map((example) => fields(example.spec))
    .filter((spec) => resolveDrawing(spec as never).mode !== "slot");
  for (const dashboard of showcaseDashboards)
    for (const panel of dashboard.sections.flatMap((section) => section.panels)) {
      const spec = fields(panel.spec);
      const covered = drawn.some(
        (example) =>
          (example.kind ?? example.block) === (spec.kind ?? spec.block) &&
          example.layout === spec.layout &&
          Object.keys(spec).every((key) => key in example),
      );
      if (!covered) continue;
      const drawing = resolveDrawing(panel.spec);
      expect(drawing.mode === "slot" ? drawing.reason : "draws", `${dashboard.slug} ${panel.id}`).toBe("draws");
    }
});

test("a kind's page lists each option once, with the values the schema accepts, and short guidance", () => {
  for (const kind of chartShowcaseKinds) {
    const { options, useFor, avoidFor, a11y } = kindGuidance(kind);
    const names = options.map((option) => option.name);
    expect(new Set(names).size, kind.kind).toBe(names.length);
    // A detail such as forecast.from belongs to its option.
    for (const name of names.filter((name) => name.includes("."))) expect(names, `${kind.kind} ${name}`).not.toContain(name.split(".")[0]);
    for (const list of [useFor, avoidFor]) expect(list.length, kind.kind).toBeLessThanOrEqual(GUIDANCE_LIMIT);
    // The keyboard is described once.
    expect(a11y.filter((item) => /arrow keys/i.test(item)).length, kind.kind).toBeLessThanOrEqual(1);
  }
  // Enumerated options read their values from the schema, such as every bar layout once the build has them.
  for (const kind of chartShowcaseKinds) {
    const spec = kind.examples[0]!.spec as Record<string, unknown>;
    for (const option of kindGuidance(kind).options) {
      const values = typeof spec.kind === "string" ? schemaValues(spec.kind, option.name) : undefined;
      if (values) expect(option.type, `${kind.kind}.${option.name}`).toBe(values.map((value) => JSON.stringify(value)).join(" | "));
    }
  }
  // An option this build rejects is not listed.
  const bar = kindGuidance(chartShowcaseKinds.find((kind) => kind.kind === "bar")!);
  expect(bar.options.some((option) => option.name === "layout")).toBe(schemaValues("bar", "layout") !== undefined);
});

test("dashboard panels have unique ids and say what each slot stands for", () => {
  for (const dashboard of showcaseDashboards) {
    const ids = dashboard.sections.flatMap((section) => section.panels.map((panel) => panel.id));
    expect(new Set(ids).size, dashboard.slug).toBe(ids.length);
    for (const panel of dashboard.sections.flatMap((section) => section.panels)) expect(panel.intended.length, panel.id).toBeGreaterThan(0);
  }
});
