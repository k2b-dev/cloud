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
