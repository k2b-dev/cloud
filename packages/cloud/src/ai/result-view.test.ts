import { expect, test } from "bun:test";
import type { Message } from "@k2b/nessi";
import { capabilityResultView, modelCapabilityMessage, modelCapabilityResult } from "./result-view";

const result = {
  data: { rows: [{ name: "Vase", count: 12 }] },
  summary: "One object",
  view: {
    version: 1,
    blocks: [{ kind: "Table", title: "Objects", rows: { from: ["rows"] }, columns: [{ path: ["name"], label: "Name" }] }],
  },
  refs: [{ type: "inventory.item", id: "v1" }],
  page: { hasMore: false },
  links: [{ rel: "open", href: "/app/inventory" }],
};

test("the human projection binds a raw view without changing the saved envelope", () => {
  const original = structuredClone(result);
  expect(capabilityResultView(result)?.blocks[0]).toMatchObject({ kind: "Table", rows: result.data.rows });
  expect(result).toEqual(original);
});
test("old saved tables convert to blocks on read, preserving exact values and safe row links", () => {
  const old = {
    data: [{ name: "Vase", amount: "12345678901234567890.1234", links: [{ href: "/app/catalog/v1" }] }],
    presentation: {
      kind: "table",
      rowsPath: [],
      columns: [
        { path: ["name"], label: "Name" },
        { path: ["amount"], label: "Amount", format: "number" },
      ],
      rowLinksPath: ["links"],
    },
  };
  expect(capabilityResultView(old)).toEqual({
    version: 1,
    blocks: [
      {
        kind: "Table",
        title: "Results",
        rows: [{ c0: "Vase", c1: "12345678901234567890.1234", href: "/app/catalog/v1" }],
        columns: [
          { path: ["c0"], label: "Name" },
          { path: ["c1"], label: "Amount", type: "number" },
        ],
        rowHref: ["href"],
      },
    ],
  });
  expect(old).toHaveProperty("presentation");
  expect(
    capabilityResultView({ ...old, data: [{ name: "Unsafe", links: [{ href: "javascript:alert(1)" }] }] })?.blocks[0],
  ).not.toHaveProperty("rowHref");
});
test("model input keeps the domain envelope, strips views, and includes only an English view description", () => {
  const projected = modelCapabilityResult(result);
  expect(projected).toEqual({
    data: result.data,
    summary: result.summary,
    refs: result.refs,
    page: result.page,
    links: result.links,
    viewSummary: "Shown: table (1 rows)",
  });
  expect(projected).not.toHaveProperty("view");
  expect(modelCapabilityResult({ data: {}, view: { bad: true } })).toEqual({ data: {} });
  const message: Message = {
    role: "tool_result",
    callId: "call1",
    name: "inventory__query__list",
    result,
    historicalResult: { originLoopId: "old", value: result },
  };
  const model = modelCapabilityMessage(message);
  expect(model.role === "tool_result" ? model.result : null).toEqual(projected);
  expect(model.role === "tool_result" ? model.historicalResult?.value : null).toEqual(projected);
  expect(message.result).toHaveProperty("view");
});
