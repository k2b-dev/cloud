import { expect, test } from "bun:test";
import { generateCodeSdk } from "./generator";
import { CODE_PAGE_LIMITS, validateCodePage } from "./page-contract";

const page = (children: unknown[] = []) => ({ version: 1, kind: "Page", title: "Workshop", children });
const codeId = "c_page";
test("Code pages accept the Sankey builder and reject a cyclic flow", async () => {
  const sdk = generateCodeSdk([], { mode: "personal" });
  const ui = await import(`data:text/javascript;base64,${Buffer.from(sdk.runtime).toString("base64")}`);
  const props = {
    title: "Flow",
    nodes: [
      { id: "in", label: "Incoming", tone: "in" },
      { id: "out", label: "Outgoing" },
    ],
    links: [{ source: "in", target: "out", value: 42 }],
  };
  const description = { kind: "sankey", ...props };
  const block = ui.Chart.Sankey(props);
  expect(block).toEqual({ kind: "Chart", description });
  expect(validateCodePage(page([block]), codeId)).toEqual(page([block]));
  expect(() =>
    validateCodePage(
      page([
        {
          kind: "Chart",
          description: { ...description, links: [...description.links, { source: "out", target: "in", value: 1 }] },
        },
      ]),
      codeId,
    ),
  ).toThrow();
});
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
  // A handler smuggled in as a prop never reaches JSON: the runtime refuses it before serializing.
  const handler = runtime.jsx(runtime.Page, { title: "P" }, runtime.jsx(runtime.Text, { onClick: () => {} }, "Hi"));
  runtime.app.get("/bad", (c: { page(value: unknown): Response }) => c.page(handler));
  await expect(runtime.__codeSdk.run("route:GET:/bad", input)).rejects.toThrow("code_page_data_only");
  // An optional prop passed as undefined, as TSX allows for `error={errors.name}`, counts as absent.
  const optional = runtime.jsx(
    runtime.Page,
    { title: "Form", subtitle: undefined },
    runtime.jsx(
      runtime.Form,
      { title: "F", action: "/save", submit: "Save", width: undefined },
      runtime.jsx(runtime.Field.Number, { name: "hours", label: "Hours", value: undefined, error: undefined }),
    ),
    runtime.jsx(runtime.Stats, null, runtime.jsx(runtime.Stat, { label: "S", value: 1, format: { style: "number", decimals: undefined } })),
  );
  runtime.app.get("/optional", (c: { page(value: unknown): Response }) => c.page(optional));
  const drawn = await runtime.__codeSdk.run("route:GET:/optional", input);
  expect(validateCodePage(JSON.parse(JSON.stringify(drawn.tree)), codeId).children.map((node) => node.kind)).toEqual(["Form", "Stats"]);
  runtime.app.get("/holes", (c: { page(value: unknown): Response }) =>
    c.page(runtime.jsx(runtime.Page, { title: "P" }, runtime.jsx(runtime.Chart.Sparkline, { title: "S", data: [1, undefined, 2] }))),
  );
  await expect(runtime.__codeSdk.run("route:GET:/holes", input)).rejects.toThrow("code_page_data_only");
  runtime.app.get("/root", (c: { page(value: unknown): Response }) => c.page(runtime.jsx(runtime.Text, null, "Hi")));
  await expect(runtime.__codeSdk.run("route:GET:/root", input)).rejects.toThrow("code_page_blocks");
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
test("blocks compose their parts and refuse a part in the wrong place before Core sees the page", async () => {
  const sdk = generateCodeSdk([], { mode: "personal" });
  const ui = await import(`data:text/javascript;base64,${Buffer.from(sdk.runtime).toString("base64")}`);
  const { jsx } = ui;
  const chart = jsx(ui.Chart.Bar, { width: "half", title: "Items", data: [{ label: "One", value: 2 }] });
  expect(chart).toEqual({ kind: "Chart", width: "half", description: { kind: "bar", title: "Items", data: [{ label: "One", value: 2 }] } });
  const form = jsx(
    ui.Form,
    { title: "Find", action: "/find", submit: "Find" },
    jsx(ui.Field.Text, { name: "query", label: "Query", required: true }),
    jsx(ui.Field.Select, { name: "status", label: "Status" }, [jsx(ui.Option, { value: "open", label: "Open" })]),
  );
  expect(form).toEqual({
    kind: "Form",
    title: "Find",
    action: "/find",
    submit: "Find",
    fields: [
      { type: "text", name: "query", label: "Query", required: true },
      { type: "select", name: "status", label: "Status", options: [{ value: "open", label: "Open" }] },
    ],
  });
  const stats = jsx(ui.Stats, null, jsx(ui.Stat, { label: "Open", value: 3 }));
  expect(stats).toEqual({ kind: "Stats", items: [{ label: "Open", value: 3 }] });
  expect(() =>
    validateCodePage(page([chart, form, stats, jsx(ui.Chart.Empty, { title: "Orders", empty: "None yet." })]), codeId),
  ).not.toThrow();
  for (const misplaced of [
    () => jsx(ui.Form, { title: "F", action: "/x", submit: "Go" }, jsx(ui.Text, null, "not a field")),
    () => jsx(ui.Stats, null, jsx(ui.Column, { key: "a", label: "A" })),
    () => jsx(ui.Table, { title: "T", rows: [] }, "text"),
    () => jsx(ui.Field.Select, { name: "s", label: "S" }, jsx(ui.Field.Text, { name: "t", label: "T" })),
    () => jsx(ui.Field.Text, { name: "t", label: "T" }, "child"),
    () => jsx(ui.Chart.Bar, { title: "C", data: [{ label: "A", value: 1 }] }, jsx(ui.Text, null, "x")),
  ])
    expect(misplaced).toThrow("code_page_child");
  // A part on its own is no page node: Core refuses it like any unknown kind.
  expect(() => validateCodePage(page([jsx(ui.Field.Text, { name: "t", label: "T" })]), codeId)).toThrow();
  expect(() => validateCodePage(page([jsx(ui.Stat, { label: "S", value: 1 })]), codeId)).toThrow();
  // Only SDK blocks build pages; the chart family itself is no block.
  expect(() => jsx(ui.Chart, { title: "C" })).toThrow("code_page_component");
  // A hand-written description never enters a page, and a block cannot be changed after it is built.
  expect(() => jsx(ui.Section, { title: "S" }, { kind: "Text", text: "hand-written" })).toThrow("code_page_blocks");
  expect(() => jsx(ui.Page, { title: "P" }, jsx(ui.Field.Text, { name: "t", label: "T" }))).toThrow("code_page_child");
  const built = jsx(ui.Page, { title: "P" }, jsx(ui.Text, null, "Hello"));
  expect(Object.isFrozen(built) && Object.isFrozen(built.children)).toBe(true);
  expect(() => built.children.push({ kind: "Text", text: "added" })).toThrow();
});
test("routes draw only pages that the SDK's blocks built", async () => {
  const sdk = generateCodeSdk([], { mode: "personal" });
  const runtime = await import(`data:text/javascript;base64,${Buffer.from(sdk.runtime).toString("base64")}`);
  type Route = { page(value: unknown): Response };
  runtime.app.get("/built", (c: Route) => c.page(runtime.jsx(runtime.Page, { title: "Built" }, runtime.jsx(runtime.Text, null, "Hi"))));
  runtime.app.get("/object", (c: Route) => c.page({ version: 1, kind: "Page", title: "Object", children: [] }));
  const request = (path: string) => ({
    method: "GET",
    path,
    query: "",
    contentType: "text/plain",
    body: "",
    params: {},
    user: { id: "v", groups: [], kind: "user", provider: "local", name: "Visitor" },
  });
  expect(await runtime.__codeSdk.run("route:GET:/built", request("/built"))).toEqual({
    kind: "page",
    status: 200,
    tree: { kind: "Page", version: 1, title: "Built", children: [{ kind: "Text", text: "Hi" }] },
  });
  await expect(runtime.__codeSdk.run("route:GET:/object", request("/object"))).rejects.toThrow("code_page_blocks");
});
test("pages carry their place and read time, panels their height, and data blocks the shared descriptions' fields", () => {
  const table = {
    kind: "Table",
    title: "Campaigns",
    subtitle: "Latest 6 of 38",
    search: true,
    columns: [
      { key: "name", label: "Campaign", priority: 1 },
      { key: "status", label: "Status", type: "status", states: { sending: { label: "Sending", tone: "running" } } },
      { key: "revenue", label: "Revenue", type: "amount", format: { style: "currency", currency: "EUR" } },
    ],
    rows: [{ name: "Weekly letter 44", status: "sending", revenue: 4610 }],
  };
  const stats = { kind: "Stats", items: [{ label: "Revenue", value: 4610, icon: "ti ti-coin-euro", tone: "emerald" }] };
  const detail = {
    kind: "Detail",
    title: "Order",
    height: "sm",
    items: [{ label: "Total", value: 1290, format: { style: "currency", currency: "EUR" } }],
  };
  const full = {
    ...page([stats, table, detail, { kind: "Chart", title: "Opens", empty: "No opens yet.", height: "lg" }]),
    eyebrow: "Pulse · Website",
    asOf: "2026-11-06T09:40:00Z",
  };
  expect<unknown>(validateCodePage(full, codeId)).toEqual(full);
  for (const bad of [
    { ...full, asOf: "yesterday" },
    { ...full, eyebrow: "x".repeat(81) },
    page([{ ...table, height: "md" }]),
    page([{ ...table, columns: [{ key: "a", label: "A", format: { unit: "kg" } }] }]),
    page([{ ...table, columns: [{ key: "a", label: "A", format: { style: "currency" } }] }]),
    page([{ ...detail, items: [] }]),
    page([{ ...detail, title: "   " }]),
    page([{ ...table, columns: [{ key: "a", label: "A", type: "html" }] }]),
    page([{ ...table, columns: [{ key: "a", label: "A", type: "status", states: { open: { label: "Open", tone: "pink" } } }] }]),
    page([{ ...table, columns: [{ key: "a", label: "A", priority: 4 }] }]),
    page([{ ...stats, items: [{ label: "R", value: 1, tone: "plum" }] }]),
    page([{ ...stats, items: [{ label: "R", value: 1, tone: "in" }] }]),
    page([{ ...detail, title: "x".repeat(161) }]),
    page([{ ...detail, items: Array.from({ length: CODE_PAGE_LIMITS.details + 1 }, () => ({ label: "L", value: 1 })) }]),
  ])
    expect(() => validateCodePage(bad, codeId)).toThrow();
});
test("every kind of the chart schema is a Chart block, so a new kind needs no Code change", async () => {
  const { chartKindSchema } = await import("@k2b/editor/chart-schema");
  const sdk = generateCodeSdk([], { mode: "personal" });
  const ui = await import(`data:text/javascript;base64,${Buffer.from(sdk.runtime).toString("base64")}`);
  for (const kind of chartKindSchema().options) expect(typeof ui.Chart[kind[0]!.toUpperCase() + kind.slice(1)], kind).toBe("function");
  expect(sdk.declarations).toContain("Capitalize<K>");
  const skill = await Bun.file(new URL("../../../assistant/src/skills/code-authoring/references/pages.md", import.meta.url)).text();
  const table = skill.split("| Block | Props | Children |")[1]!.split("\n\n")[0]!;
  const documented = [...table.matchAll(/`Chart\.([A-Za-z]+)`/g)].map((match) => match[1]!).filter((name) => name !== "Empty");
  expect(documented.sort()).toEqual(
    chartKindSchema()
      .options.map((kind) => kind[0]!.toUpperCase() + kind.slice(1))
      .sort(),
  );
});
