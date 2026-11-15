import type { BoundBlockView } from "../blocks/schema";
import { parseCloudAiChartToolView } from "./view-block";

/**
 * The narrow translation of Gustav's own visuals into blocks, without checking them: the chat uses it while a call
 * still runs, so the island stands from the first frame, and `gustav-views.ts` checks the same blocks on the server
 * before it stores them with the result. One chart becomes a `Chart` block; a group its charts under the group's
 * title, side by side for a grid. A card becomes one flat key figure.
 */
export const chartToolBlocks = (args: unknown): BoundBlockView | null => {
  const parsed = parseCloudAiChartToolView(args);
  if (!parsed) return null;
  if (parsed.view === "chart") {
    const { view: _view, ...description } = parsed;
    return { version: 1, blocks: [{ kind: "Chart", description }] };
  }
  const width = parsed.layout === "grid" ? ("half" as const) : undefined;
  const charts = parsed.charts.map((description) => ({ kind: "Chart" as const, description, ...(width ? { width } : {}) }));
  return {
    version: 1,
    blocks: parsed.title
      ? [{ kind: "Section", title: parsed.title, ...(parsed.subtitle ? { description: parsed.subtitle } : {}), children: charts }]
      : charts,
  };
};

const cut = (value: unknown, limit = 80): string | undefined => {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
};

/**
 * One card call as one flat key figure: its title is the label, its value the figure, and the change or scope the one
 * quiet line under it. Consecutive cards stand together in one row (`chat/turn-layout.ts`). The emoji has no place in a
 * key figure; the colour tone of the old card is left to the shared tiles.
 */
export const cardToolBlocks = (args: unknown): BoundBlockView | null => {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const card: Record<string, unknown> = Object.fromEntries(Object.entries(args));
  const label = cut(card.title);
  const value = cut(card.value);
  if (!label || !value) return null;
  const trend = [cut(card.trendValue, 40), cut(card.trendLabel, 40)].filter(Boolean).join(" ");
  const note = cut([trend, cut(card.caption)].filter(Boolean).join(" · "));
  return { version: 1, blocks: [{ kind: "Stats", items: [{ label, value, ...(note ? { note } : {}) }] }] };
};
