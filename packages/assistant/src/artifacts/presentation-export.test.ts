import { expect, test } from "bun:test";
import { ChatPresentationInput } from "./chat-presentation-contracts";
import { presentationChartSvg, presentationHtml } from "./presentation-export";
import { AnalyticsNode } from "./runtime/analytics-contracts";

const parse = (nodes: unknown[]) => nodes.map((node) => AnalyticsNode.parse(node));
test("document export retains filter values and all rows without executable controls", () => {
  const nodes = parse([
    { id: "slider", type: "slider", label: "Quantity", value: 7, min: 1, max: 10 },
    { id: "action", type: "button", label: "Delete everything" },
    { id: "text", type: "text", value: '<script>alert("bad")</script>' },
    {
      id: "table",
      type: "table",
      rowKey: "id",
      columns: [{ key: "value", label: "Value" }],
      rows: Array.from({ length: 70 }, (_, i) => ({ id: String(i), value: i })),
    },
  ]);
  const html = presentationHtml(nodes, "Report", "de");
  expect(html).toContain("Quantity");
  expect(html).toContain("<p>7</p>");
  expect(html).not.toContain("Delete everything");
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<input");
  expect(html).not.toContain("<button");
  expect(html.match(/<td>/g)?.length).toBe(70);
});
test("charts export SVG and keep actual source context", () => {
  const [node] = parse([
    {
      id: "chart",
      type: "explorer",
      columns: [{ key: "value", label: "Value" }],
      data: {
        rowKey: "id",
        rows: [{ id: "a", label: "A", value: 12 }],
        chart: { kind: "bar", category: "label", value: "value" },
        context: {
          mode: "snapshot",
          asOf: "2026-09-20T10:00:00Z",
          sources: [{ label: "Reviewed CSV" }],
          status: "partial",
          note: "Missing one day",
        },
      },
    },
  ]);
  expect(presentationChartSvg(node!, "en")).toContain("<svg");
  const html = presentationHtml([node!], "Report", "en");
  expect(html).toContain("Reviewed CSV");
  expect(html).toContain("Missing one day");
  expect(html).toContain("2026-09-20T10:00:00Z");
});
test("rejects cyclic presentations and unsettled export instead of losing content", () => {
  const nodes = parse([{ id: "loop", type: "layout", layout: "column", children: ["loop"] }]);
  expect(() => ChatPresentationInput.parse({ conversationId: "abc234", callId: "x", title: "x", code: "x", nodes, inputs: [] })).toThrow(
    "Cyclic",
  );
  expect(() => presentationHtml(parse([{ id: "t", type: "text", value: "pending", loading: true }]), "Test", "en")).toThrow("loading");
});
