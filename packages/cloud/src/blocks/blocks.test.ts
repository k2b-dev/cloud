import { describe, expect, test } from "bun:test";
import { BLOCK_LIMITS, bindView, blocksSummary, blocksText, validateBlocks } from "./index";
import { CodePageFieldSchema, CodePageNodeSchema } from "./schema";

const ctx = { appId: "catalog", appPrefixes: ["/app/catalog", "/api/catalog"] };
const view = (blocks: unknown[]) => ({ version: 1, blocks });
const bound = (blocks: unknown[], data: unknown = {}) => bindView(view(blocks), data).blocks;
const table = {
  kind: "Table",
  title: "Items",
  rows: [{ name: "Vase", id: "v1", href: "/app/catalog/v1" }],
  columns: [{ path: ["name"], label: "Name" }],
};
const choice = {
  kind: "Choice",
  id: "category",
  title: "Welche Kategorie…",
  mode: "one",
  options: [
    { id: "cat_jug", title: "Jug" },
    { id: "cat_deco", title: "Decoration" },
  ],
  option: { id: ["id"], title: ["title"] },
  submit: "Choose",
  then: { query: "catalog.query.matches", input: {}, field: "category" },
};
const draft = {
  kind: "Draft",
  context: [{ label: "To", value: [{ name: "Ruth", address: "ruth@example.test" }] }],
  fields: [{ name: "subject", label: "Subject", type: "text", value: "Hello" }],
};
const cards = {
  kind: "Cards",
  title: "Ähnliche Objekte",
  items: [{ id: "v1", name: "Vase", image: "/api/catalog/v1/image", price: 12 }],
  card: { id: ["id"], title: ["name"], image: ["image"], price: ["price"] },
};

describe("block host contract", () => {
  test("shared blocks work on every host; actions, choices and drafts keep their owners", () => {
    const shared = bound([
      {
        kind: "Section",
        title: "Result",
        children: [
          { kind: "Text", text: "Hello" },
          { kind: "Heading", text: "Items" },
          { kind: "Notice", title: "Ready", tone: "info" },
        ],
      },
      cards,
      { kind: "Image", src: "/api/catalog/v1/image", alt: "Vase" },
      {
        kind: "Detail",
        title: "State",
        items: [{ label: "State", value: "done", before: "open", type: "status", states: { done: { label: "Done", tone: "ok" } } }],
      },
    ]);
    for (const host of ["page", "result", "review", "preview"] as const) expect(validateBlocks(shared, host, ctx)).toHaveLength(4);
    for (const host of ["page", "result", "review", "preview"] as const) {
      if (host === "result") expect(validateBlocks(bound([choice]), host, ctx)).toHaveLength(1);
      else expect(() => validateBlocks(bound([choice]), host, ctx)).toThrow();
      if (host === "review") expect(validateBlocks(bound([draft]), host, ctx)).toHaveLength(1);
      else expect(() => validateBlocks(bound([draft]), host, ctx)).toThrow();
      const action = bound([{ kind: "Button", label: "Go", action: "/go" }]);
      if (host === "page") expect(validateBlocks(action, host, ctx)).toHaveLength(1);
      else expect(() => validateBlocks(action, host, ctx)).toThrow();
    }
  });
  test("links cannot escape their host or normalize into a different route", () => {
    for (const href of [
      "javascript:alert(1)",
      "data:text/html,x",
      "//evil.test",
      "/app/other/x",
      "/app/catalogue/x",
      "/app/catalog/../other",
      "/app/catalog/%2e%2e/x",
      "/app/catalog/%2fx",
      "/app/catalog/%5cx",
      "/app/catalog/%252fx",
      "/app/catalog//evil",
      "/app/catalog/%00x",
    ])
      expect(() => validateBlocks(bound([{ kind: "Link", label: "Go", href }]), "result", ctx), href).toThrow();
    for (const href of ["/app/catalog/x", "/open/contacts.contact/~one", "https://example.test/x"])
      expect(validateBlocks(bound([{ kind: "Link", label: "Go", href }]), "result", ctx)).toHaveLength(1);
    expect(() => validateBlocks(bound([{ kind: "Link", label: "Go", href: "https://example.test/x" }]), "review", ctx)).toThrow();
    expect(validateBlocks(bound([{ kind: "Link", label: "Go", href: "/approvals" }]), "review", ctx)).toHaveLength(1);
  });
  test("images and mapped links undergo the same target checks", () => {
    for (const src of [
      "https://evil.test/image",
      "data:image/png,x",
      "/api/other/image",
      "/api/catalogue/image",
      "/api/catalog/%2e%2e/other",
    ]) {
      expect(() => validateBlocks(bound([{ kind: "Image", src, alt: "x" }]), "result", ctx)).toThrow();
      expect(() => validateBlocks(bound([{ ...cards, items: [{ id: "v1", name: "Vase", image: src }] }]), "result", ctx)).toThrow();
    }
    expect(() =>
      validateBlocks(bound([{ ...table, rowHref: ["href"], rows: [{ name: "Vase", href: "javascript:x" }] }]), "result", ctx),
    ).toThrow();
  });
  test("only one choice and draft; then names a query in this app", () => {
    expect(() => validateBlocks(bound([choice, { ...choice, id: "second" }]), "result", ctx)).toThrow();
    expect(() => validateBlocks(bound([draft, draft]), "review", ctx)).toThrow();
    for (const query of [
      "catalog.action.remove",
      "other.query.matches",
      "catalog.query.",
      "catalog.query.matches/now",
      "catalog__action__remove",
    ])
      expect(() => validateBlocks(bound([{ ...choice, then: { ...choice.then, query } }]), "result", ctx)).toThrow();
    expect(() => bound([{ ...draft, fields: [{ name: "email", label: "Email", type: "email" }] }])).toThrow();
    expect(() => validateBlocks(bound([{ ...draft, fields: [draft.fields[0], draft.fields[0]] }]), "review", ctx)).toThrow();
  });
  test("pages retain key columns; other hosts use relative paths", () => {
    expect(
      validateBlocks(bound([{ ...table, columns: [{ key: "name", label: "Name" }], rows: [{ name: "One" }] }]), "page", ctx),
    ).toHaveLength(1);
    expect(() => validateBlocks(bound([table]), "page", ctx)).toThrow();
    expect(() => validateBlocks(bound([{ ...table, columns: [{ key: "name", label: "Name" }] }]), "result", ctx)).toThrow();
  });
});

describe("binding and budgets", () => {
  test("the re-exported Code node and field schemas retain their original string limits", () => {
    const tooLong = "x".repeat(BLOCK_LIMITS.bytes + 1);
    expect(CodePageNodeSchema.safeParse({ kind: "Text", text: tooLong }).success).toBe(false);
    expect(CodePageFieldSchema.safeParse({ name: "body", label: "Body", type: "textarea", value: tooLong }).success).toBe(false);
    expect(bound([{ ...draft, fields: [{ name: "body", label: "Body", type: "textarea", value: tooLong }] }])).toHaveLength(1);
  });

  test("binds every collection site and chart values, preserving relative mappings", () => {
    const result = bound(
      [
        { kind: "Stats", items: { from: ["stats"] } },
        { ...table, rows: { from: ["rows"] } },
        { kind: "Detail", title: "Facts", items: { from: ["details"] } },
        { ...cards, items: { from: ["rows"] } },
        { ...choice, options: { from: ["options"] } },
        { kind: "Chart", description: { kind: "bar", title: "Prices", data: { from: ["points"] } } },
      ],
      {
        stats: [{ label: "Count", value: 1 }],
        rows: [{ id: "v1", name: "Vase" }],
        details: [{ label: "Name", value: "Vase" }],
        options: choice.options,
        points: [{ label: "One", value: 3 }],
      },
    );
    expect(validateBlocks(result, "result", ctx)).toHaveLength(6);
    expect(result[1]).toMatchObject({ rows: [{ id: "v1", name: "Vase" }], columns: table.columns });
    expect(result[5]).toMatchObject({ description: { data: [{ label: "One", value: 3 }] } });
    expect(bound([{ ...table, rows: { from: [] } }], [{ name: "Root" }])[0]).toMatchObject({ rows: [{ name: "Root" }] });
    expect(() => bound([{ ...table, rows: { from: ["missing"] } }])).toThrow();
    expect(() =>
      bound([{ kind: "Chart", description: { kind: "bar", title: { from: ["title"] }, data: [{ label: "One", value: 1 }] } }], {
        title: "No",
      }),
    ).toThrow();
  });
  test("never follows prototypes or getters, and rejects cycles and executable data before parsing", () => {
    for (const segment of ["__proto__", "constructor", "prototype"])
      expect(() => bound([{ ...table, rows: { from: [segment] } }])).toThrow();
    let reads = 0;
    expect(() =>
      bound([{ ...table, rows: { from: ["rows"] } }], {
        get rows() {
          reads++;
          return [];
        },
      }),
    ).toThrow();
    expect(reads).toBe(0);
    expect(() => bound([{ ...table, rows: { from: ["rows"] } }], Object.create({ rows: [] }))).toThrow();
    const cycle: unknown[] = [];
    cycle.push(cycle);
    expect(() => bound([], cycle)).toThrow();
    expect(() => bound([], { callback: () => {} })).toThrow();
    expect(() => bound([], JSON.parse('{"__proto__":[]}'))).toThrow();
    expect(() => bound([{ ...table, rows: { from: Array(17).fill("x") } }])).toThrow();
  });
  test("enforces node, depth, row, column, field and incremental expansion limits", () => {
    expect(() => bound(Array.from({ length: 257 }, () => ({ kind: "Text", text: "x" })))).toThrow();
    let node: unknown = { kind: "Text", text: "x" };
    for (let i = 0; i < 12; i++) node = { kind: "Section", title: "Deep", children: [node] };
    expect(() => bound([node])).toThrow();
    for (const block of [
      { ...table, rows: Array(201).fill({ name: "x" }) },
      { ...cards, items: Array(201).fill({ id: "v1", name: "Vase" }) },
      { ...choice, options: Array(201).fill(choice.options[0]) },
      { ...table, columns: Array(21).fill(table.columns[0]) },
      { ...draft, fields: Array(41).fill(draft.fields[0]) },
    ])
      expect(() => bound([block])).toThrow();
    const rows = [{ name: "x".repeat(80_000) }];
    expect(() => bound(Array(4).fill({ ...table, rows: { from: ["rows"] } }), { rows })).toThrow("blocks_limit");
    expect(() => bound([{ ...cards, items: { from: ["rows"] } }], { rows: Array(201).fill({ id: "v1", name: "Vase" }) })).toThrow();
    expect(BLOCK_LIMITS).toMatchObject({ nodes: 256, depth: 12, rows: 200, columns: 20, fields: 40 });
  });
});

test("plain text and model summary snapshots", () => {
  const blocks = bound([
    cards,
    {
      kind: "Detail",
      title: "Status",
      items: [
        {
          label: "State",
          before: "open",
          value: "done",
          type: "status",
          states: { open: { label: "Open", tone: "neutral" }, done: { label: "Done", tone: "ok" } },
        },
      ],
    },
    { ...table, rows: [{ name: "Vase" }] },
    choice,
  ]);
  expect(blocksText(blocks, { locale: "en", timeZone: "UTC" })).toMatchInlineSnapshot(`
"Ähnliche Objekte
Vase
12

Status
State: Open → Done

Items
Name
Vase

Welche Kategorie…
1. Jug [cat_jug]
2. Decoration [cat_deco]
Choose"
`);
  expect(blocksSummary(blocks)).toMatchInlineSnapshot(
    '"Shown: cards "Ähnliche Objekte" (1), details "Status", table (1 rows), open choice "Welche Kategorie…": "cat_jug", "cat_deco""',
  );
  expect(
    blocksText(bound([{ kind: "Stats", items: [{ label: "Price", value: 1234.5, format: { style: "currency", currency: "EUR" } }] }]), {
      locale: "de-DE",
      timeZone: "Europe/Berlin",
    }),
  ).toBe("Price: 1.234,50 €");
});

test("review content and metadata retain separate byte budgets, and drafts must fit inline", () => {
  const blocks = [{ kind: "Text", text: "x".repeat(300_000) }];
  const review = { sentence: "Read the content", view: view(blocks) };
  expect(validateBlocks(blocks, "review", { ...ctx, envelope: review })).toHaveLength(1);
  expect(() => validateBlocks(blocks, "result", ctx)).toThrow();
  expect(() => validateBlocks([], "review", { ...ctx, envelope: { metadata: "x".repeat(32 * 1024) } })).toThrow();
  const largeDraft = [{ ...draft, fields: [{ ...draft.fields[0], value: "x".repeat(256 * 1024) }] }];
  expect(() => validateBlocks(largeDraft, "review", ctx)).toThrow();
  expect(() =>
    validateBlocks([], "review", { ...ctx, envelope: { view: view([{ kind: "Text", text: "x".repeat(16 * 1024 * 1024) }]) } }),
  ).toThrow();
  expect(() => validateBlocks([], "result", { ...ctx, envelope: { data: "x".repeat(256 * 1024) } })).toThrow();
});

test("terminal text uses the chart's shared accessible data table", () => {
  const blocks = bound([{ kind: "Chart", description: { kind: "bar", title: "Prices", data: [{ label: "Vase", value: 12.5 }] } }]);
  expect(blocksText(blocks, { locale: "en", timeZone: "UTC" })).toMatchInlineSnapshot(`
"Prices
Category | Value
Vase | 12.5"
`);
});

test("number-typed decimal strings remain exact instead of being interpreted as years", () => {
  const blocks = bound([{ ...table, rows: [{ amount: "42.0000" }], columns: [{ path: ["amount"], label: "Amount", type: "number" }] }]);
  expect(blocksText(blocks, { locale: "en", timeZone: "UTC" })).toBe("Items\nAmount\n42.0000");
});

test("terminal text retains table destinations and card image labels and badges", () => {
  const blocks = bound([
    { ...table, rowHref: ["href"] },
    {
      ...cards,
      items: [{ id: "v1", name: "Vase", alt: "Blue porcelain vase", badges: ["New", "Porcelain"] }],
      card: { ...cards.card, imageAlt: ["alt"], badges: ["badges"] },
    },
  ]);
  const text = blocksText(blocks, { locale: "en", timeZone: "UTC" });
  expect(text).toContain("Vase | /app/catalog/v1");
  expect(text).toContain("Blue porcelain vase\nNew, Porcelain");
});
