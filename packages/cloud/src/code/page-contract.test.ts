import { expect, test } from "bun:test";
import { generateCodeSdk } from "./generator";
import { CODE_PAGE_LIMITS, validateCodePage } from "./page-contract";

const page = (children: unknown[] = []) => ({ version: 1, kind: "Page", title: "Workshop", children });
const codeId = "c_page";
test("versioned pages accept every allowed block and the portable chart description", () => {
  const children = [
    { kind: "Section", title: "Overview", children: [{ kind: "Text", text: "Hello" }] },
    { kind: "Heading", level: 2, text: "Details" },
    { kind: "Table", title: "Items", columns: [{ key: "name", label: "Name" }], rows: [{ name: "One" }] },
    { kind: "Form", title: "Find", action: "/find", fields: [{ type: "scan", name: "barcode", label: "Barcode" }], submit: "Find" },
    { kind: "Detail", title: "Item", items: [{ label: "Count", value: 2 }] },
    { kind: "Chart", description: { kind: "bar", title: "Items", data: [{ label: "One", value: 2 }] } },
    { kind: "Link", label: "Next", href: "/next" },
    { kind: "Button", label: "Save", action: "/save", values: { item: "one" } },
    { kind: "Action", label: "Save", action: "/save" },
    { kind: "Notice", tone: "info", title: "Saved", text: "Two items" },
  ];
  expect<unknown>(validateCodePage(page(children), codeId)).toEqual(page(children));
});
test("unknown kinds, fields, executable values and raw markup are rejected rather than stripped", () => {
  for (const kind of ["div", "script", "style", "iframe", "HTML", "SVG", "svg", "Image", "Live", "Unknown"])
    expect(() => validateCodePage(page([{ kind }]), codeId)).toThrow();
  for (const child of [
    { kind: "Text", text: "Hi", innerHTML: "<script>" },
    { kind: "Text", text: "Hi", onClick: () => {} },
    { kind: "Text", text: undefined },
    { kind: "Chart", description: { kind: "bar", title: "Items", data: [{ label: "One", value: 2 }], onSelect: "callback" } },
    {
      kind: "Chart",
      description: {
        kind: "bar",
        title: "Items",
        data: [{ label: "One", value: 2 }],
        yAxis: { format: { style: "number", callback: "bad" } },
      },
    },
  ])
    expect(() => validateCodePage(page([child]), codeId)).toThrow();
  expect(() => validateCodePage({ ...page(), version: 2 }, codeId)).toThrow();
  expect(() => validateCodePage(page([{ kind: "Page", title: "Nested", version: 1, children: [] }]), codeId)).toThrow();
});
test("only own paths may be links or POST destinations", () => {
  for (const path of ["https://foreign.test", "//foreign.test", "/../admin", "/code/c_other/save", "/%2fadmin"])
    for (const child of [
      { kind: "Link", label: "Go", href: path },
      { kind: "Action", label: "Go", action: path },
      { kind: "Form", title: "Go", action: path, fields: [{ type: "text", name: "q", label: "Query" }], submit: "Go" },
    ])
      expect(() => validateCodePage(page([child]), codeId)).toThrow();
});
test("depth, size, cyclic objects, accessors and duplicate fields stay outside the contract", () => {
  let node: unknown = { kind: "Text", text: "Hi" };
  for (let i = 0; i < CODE_PAGE_LIMITS.depth; i++) node = { kind: "Section", title: "Deep", children: [node] };
  expect(() => validateCodePage(page([node]), codeId)).toThrow();
  expect(() =>
    validateCodePage(page(Array.from({ length: CODE_PAGE_LIMITS.nodes + 1 }, () => ({ kind: "Text", text: "x" }))), codeId),
  ).toThrow();
  expect(() => validateCodePage(page([{ kind: "Text", text: "x".repeat(CODE_PAGE_LIMITS.bytes) }]), codeId)).toThrow();
  const cyclic: unknown[] = [];
  cyclic.push(cyclic);
  expect(() => validateCodePage(page(cyclic), codeId)).toThrow();
  let read = false;
  expect(() =>
    validateCodePage(
      page([
        {
          get kind() {
            read = true;
            return "Text";
          },
          text: "x",
        },
      ]),
      codeId,
    ),
  ).toThrow();
  expect(read).toBe(false);
  expect(() =>
    validateCodePage(
      page([
        {
          kind: "Form",
          title: "Go",
          action: "/",
          submit: "Go",
          fields: [
            { type: "text", name: "x", label: "X" },
            { type: "text", name: "x", label: "Again" },
          ],
        },
      ]),
      codeId,
    ),
  ).toThrow();
});
test("SDK builders emit only descriptions; c.page rejects handlers before JSON serialization", async () => {
  const sdk = generateCodeSdk([], { mode: "personal" });
  const runtime = await import(`data:text/javascript;base64,${Buffer.from(sdk.runtime).toString("base64")}`);
  const tree = runtime.jsx(
    runtime.Page,
    { title: "Hello" },
    runtime.jsx(runtime.Text, null, "<b>Hello</b>"),
    runtime.jsx(runtime.Chart.Bar, { title: "Items", data: [{ label: "One", value: 1 }] }),
  );
  expect(validateCodePage(tree, codeId).children[0]).toEqual({ kind: "Text", text: "<b>Hello</b>" });
  expect(() => runtime.jsx("div", {})).toThrow("code_page_component");
  runtime.app.get("/", (c: { page(value: unknown): Response }) => c.page(tree));
  const input = { method: "GET", path: "/", query: "", contentType: "text/plain", body: "", params: {}, user: null };
  expect(await runtime.__codeSdk.run("route:GET:/", input)).toEqual({ kind: "page", status: 200, tree });
  runtime.app.get("/bad", (c: { page(value: unknown): Response }) => c.page(page([{ kind: "Text", text: "Hi", onClick: () => {} }])));
  await expect(runtime.__codeSdk.run("route:GET:/bad", input)).rejects.toThrow("code_page_data_only");
  runtime.app.get("/root", (c: { page(value: unknown): Response }) => c.page({ kind: "Text", text: "Hi" }));
  await expect(runtime.__codeSdk.run("route:GET:/root", input)).rejects.toThrow("code_page_root");
  expect(runtime.jsx(runtime.Text, null, "Hello ", "Valentin", "!", 2)).toEqual({ kind: "Text", text: "Hello Valentin!2" });
  expect(() => runtime.jsx(runtime.Text, null, () => "bad")).toThrow("code_page_text");
});

test("portable chart validation runs before server rendering", () => {
  const description = {
    kind: "line",
    title: "Range",
    series: [
      {
        data: [
          { x: 1, y: 1e17 },
          { x: 2, y: 1e17 + 16 },
        ],
      },
    ],
  };
  expect(() => validateCodePage(page([{ kind: "Chart", description }]), codeId)).toThrow();
});
test("a page follows a few unique event types and fields carry the Code's validation message", () => {
  const form = {
    kind: "Form",
    title: "Find",
    action: "/find",
    submit: "Find",
    fields: [{ type: "scan", name: "barcode", label: "Barcode", value: "W-1", error: "No item has this code." }],
  };
  const table = { kind: "Table", title: "Waiting", columns: [{ key: "item", label: "Item" }], rows: [], empty: "Nothing waits." };
  const followed = { ...page([form, table]), follow: ["grids.record.changed", "mail.message.received"] };
  expect<unknown>(validateCodePage(followed, codeId)).toEqual(followed);
  for (const follow of [
    ["grids.record.changed", "grids.record.changed"],
    ["Grids.Record"],
    ["grids"],
    ["https://evil.test/event"],
    Array.from({ length: CODE_PAGE_LIMITS.follow + 1 }, (_, index) => `app.event-${index}`),
  ])
    expect(() => validateCodePage({ ...page(), follow }, codeId)).toThrow();
  expect(() => validateCodePage(page([{ ...form, fields: [{ ...form.fields[0], error: "" }] }]), codeId)).toThrow();
});
test("key figures, grid widths, section symbols and number formats are data on the allow-list", () => {
  const stats = {
    kind: "Stats",
    items: [
      {
        label: "Received",
        value: 128,
        icon: "ti ti-package",
        delta: { value: 0.123, better: "up" },
        compare: { label: "Last week", value: 114 },
        trend: [92, 101, 128],
      },
      { label: "On time", value: 0.92, format: { style: "percent" }, delta: { value: 0.04, unit: "points", better: "up" } },
      { label: "Not counted", value: null },
    ],
  };
  const section = {
    kind: "Section",
    title: "Today",
    description: "Updated with every change",
    icon: "ti ti-calendar-event",
    color: "emerald",
    children: [
      {
        kind: "Chart",
        width: "twoThirds",
        empty: "No items yet.",
        description: { kind: "bar", title: "Items", data: [{ label: "One", value: 2 }] },
      },
      { kind: "Detail", width: "third", title: "Item", items: [{ label: "Code", value: "W-1" }] },
      {
        kind: "Table",
        width: "half",
        title: "Prices",
        columns: [{ key: "price", label: "Price", format: { style: "currency", currency: "EUR" } }],
        rows: [{ price: 4 }],
      },
      {
        kind: "Form",
        width: "full",
        title: "Find",
        action: "/find",
        submit: "Find",
        fields: [{ type: "text", name: "q", label: "Query" }],
      },
    ],
  };
  const waiting = { kind: "Chart", width: "half", title: "Items", empty: "No item arrived today." };
  const full = { ...page([stats, section, waiting]), subtitle: "As of 09:40", icon: "ti ti-tool", color: "blue" };
  expect<unknown>(validateCodePage(full, codeId)).toEqual(full);
  for (const bad of [
    { ...full, icon: "ti ti-tool onload=alert(1)" },
    { ...full, icon: "<svg>" },
    { ...full, color: "plum" },
    page([{ ...section, color: "#ff00ff" }]),
    page([{ ...section, children: [{ ...section.children[1], width: "quarter" }] }]),
    page([{ kind: "Stats", items: [] }]),
    page([{ kind: "Stats", items: Array.from({ length: CODE_PAGE_LIMITS.stats + 1 }, () => ({ label: "x", value: 1 })) }]),
    page([{ kind: "Stats", items: [{ label: "x", value: 1, trend: Array.from({ length: CODE_PAGE_LIMITS.trend + 1 }, () => 1) }] }]),
    page([{ kind: "Stats", items: [{ label: "x", value: 1, delta: { value: 0.1, unit: "percent" } }] }]),
    page([{ kind: "Stats", items: [{ label: "x", value: 1, format: { style: "currency" } }] }]),
    page([{ kind: "Stats", items: [{ label: "x", value: Number.NaN }] }]),
    page([{ kind: "Chart", title: "Without anything to say" }]),
    page([{ kind: "Chart", empty: "Nothing" }]),
    page([{ ...section.children[0], title: "Two titles" }]),
  ])
    expect(() => validateCodePage(bad, codeId)).toThrow();
});
test("chart builders keep page layout beside the portable description", async () => {
  const sdk = generateCodeSdk([], { mode: "personal" });
  const runtime = await import(`data:text/javascript;base64,${Buffer.from(sdk.runtime).toString("base64")}`);
  const chart = runtime.jsx(runtime.Chart.Bar, { width: "half", empty: "None yet.", title: "Items", data: [{ label: "One", value: 2 }] });
  expect(chart).toEqual({
    kind: "Chart",
    width: "half",
    empty: "None yet.",
    description: { kind: "bar", title: "Items", data: [{ label: "One", value: 2 }] },
  });
  expect(runtime.jsx(runtime.Stats, { items: [{ label: "Open", value: 3 }] })).toEqual({
    kind: "Stats",
    items: [{ label: "Open", value: 3 }],
  });
  expect(() => validateCodePage(page([chart]), codeId)).not.toThrow();
});
