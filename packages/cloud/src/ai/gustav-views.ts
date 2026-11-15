import { bindView } from "../blocks/bind";
import { type BlockView, CodeChartDescriptionSchema } from "../blocks/schema";
import { validateBlocks } from "../blocks/validate";
import { parseCloudAiChartToolView } from "./view-block";

/**
 * Gustav's own visuals as the same blocks an app's result uses, so a chart Gustav draws looks like a chart an app
 * returns: an island under Cloud's head. A narrow translation of the chart tool's input, no second schema: one chart
 * becomes a `Chart` block; a group becomes its charts side by side or stacked, under the group's title. Input the
 * blocks cannot hold, such as more series than a block allows, returns `null` and keeps the tool's own drawing.
 */
export const chartToolView = (args: unknown): BlockView | null => {
  const parsed = parseCloudAiChartToolView(args);
  if (!parsed) return null;
  const chart = (value: unknown, width?: "half") => {
    const description = CodeChartDescriptionSchema.safeParse(value);
    return description.success ? { kind: "Chart" as const, description: description.data, ...(width ? { width } : {}) } : null;
  };
  let view: BlockView;
  if (parsed.view === "chart") {
    const { view: _view, ...description } = parsed;
    const block = chart(description);
    if (!block) return null;
    view = { version: 1, blocks: [block] };
  } else {
    const width = parsed.layout === "grid" ? ("half" as const) : undefined;
    const charts = parsed.charts.map((entry) => chart(entry, width));
    if (charts.some((entry) => entry === null)) return null;
    const blocks = charts.filter((entry) => entry !== null);
    view = {
      version: 1,
      blocks: parsed.title
        ? [{ kind: "Section", title: parsed.title, ...(parsed.subtitle ? { description: parsed.subtitle } : {}), children: blocks }]
        : blocks,
    };
  }
  try {
    validateBlocks(bindView(view, {}).blocks, "result", { appId: "core", appPrefixes: [] });
    return view;
  } catch {
    return null;
  }
};

/** The stored result of a chart call: the model reads `displayed`; people see the view. */
export const chartToolResult = (args: unknown): { displayed: true; view?: BlockView; data?: Record<string, never> } => {
  const view = chartToolView(args);
  return view ? { displayed: true, view, data: {} } : { displayed: true };
};
