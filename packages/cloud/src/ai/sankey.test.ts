import { expect, test } from "bun:test";
import { CloudAiChartInputSchema, parseCloudAiChartInput } from "./default-tool-contracts";
import { parseCloudAiChartToolView } from "./view-block";

const spec = {
  kind: "sankey",
  title: "Paths",
  nodes: [
    { id: "a", label: "Click" },
    { id: "b", label: "Read" },
  ],
  links: [{ source: "a", target: "b", value: 4 }],
};
test("model tool and saved view retain Sankey nodes/links and reject cycles", () => {
  expect(CloudAiChartInputSchema.safeParse(spec).success).toBe(true);
  expect(parseCloudAiChartInput(spec)?.kind).toBe("sankey");
  expect(parseCloudAiChartToolView(spec)).toMatchObject({ view: "chart", ...spec });
  expect(CloudAiChartInputSchema.safeParse({ ...spec, links: [...spec.links, { source: "b", target: "a", value: 2 }] }).success).toBe(
    false,
  );
});

test("model input rejects invalid locales and retains a valid BCP 47 locale", () => {
  expect(CloudAiChartInputSchema.safeParse({ ...spec, locale: "de_DE" }).success).toBe(false);
  expect(CloudAiChartInputSchema.safeParse({ ...spec, locale: "" }).success).toBe(false);
  expect(CloudAiChartInputSchema.safeParse({ kind: "bar", title: "Bars", data: [{ label: "A", value: 1 }], locale: "de-DE" }).success).toBe(
    false,
  );
  expect(parseCloudAiChartInput({ ...spec, locale: "de-DE" })).toMatchObject({ locale: "de-DE" });
  expect(CloudAiChartInputSchema.safeParse({ ...spec, legend: [{ tone: "tax", label: "Tax" }] }).success).toBe(true);
});

test("Gustav's Code building-block Sankey example passes the model and saved-view boundaries", async () => {
  const guide = await Bun.file(new URL("../../../assistant/src/skills/assistant-code-mode/references/charts.md", import.meta.url)).text();
  const example = guide.split("## Follow paths between stages")[1]?.match(/```json\n([\s\S]*?)\n```/)?.[1];
  expect(example).toBeDefined();
  const input: unknown = JSON.parse(example!);
  expect(CloudAiChartInputSchema.safeParse(input).success).toBe(true);
  expect(parseCloudAiChartToolView(input)).toMatchObject({ view: "chart", kind: "sankey" });
  const modelExample = CloudAiChartInputSchema.shape.kind.description?.split("Sankey example: ")[1];
  expect(modelExample).toBeDefined();
  expect(CloudAiChartInputSchema.safeParse(JSON.parse(modelExample!)).success).toBe(true);
});
