import type { BoundBlockView } from "../blocks/schema";
import { figureSign } from "./figure-sign";
import { parseCloudAiChartToolView } from "./view-block";

/**
 * The narrow translation of Gustav's own visuals into blocks, without checking them: the chat uses it while a call
 * still runs, so the island stands from the first frame, and `gustav-views.ts` checks the same blocks on the server
 * before it stores them with the result. One chart becomes a `Chart` block; a group its charts under the group's
 * title, side by side for a grid; plain `stat` charts become one flat row of key figures. A card becomes one flat key
 * figure.
 */
/**
 * Gustav's lines are straight with a hollow point on every value unless he says otherwise (v12, chart in an island): a
 * smooth curve can swing past its values, so a run of zeros would dip below zero.
 */
export const gustavLine = <T extends { kind: string; smooth?: boolean; points?: boolean }>(description: T): T =>
  description.kind === "line" ? { ...description, smooth: description.smooth ?? false, points: description.points ?? true } : description;

type StatItem = { label: string; value: number; icon: string; note?: string; trend?: number[] };
/**
 * A `stat` chart is a key figure: it stands as one in the flat row of key figures, not as a chart island. Only a plain
 * figure translates (title, value, subtitle, recent values); one with a unit, format, change or tooltip stays a chart,
 * because a key figure's change is a share and its format a number format.
 */
const statItem = (description: Record<string, unknown>, sign: unknown): StatItem | null => {
  if (description.kind !== "stat" || typeof description.value !== "number" || !Number.isFinite(description.value)) return null;
  if (Object.keys(description).some((key) => !["view", "kind", "title", "subtitle", "value", "sparkline"].includes(key))) return null;
  const label = cut(description.title);
  if (!label) return null;
  const note = cut(description.subtitle);
  const trend = Array.isArray(description.sparkline) ? description.sparkline.filter(Number.isFinite).slice(-60) : [];
  return { label, value: description.value, icon: figureSign(sign), ...(note ? { note } : {}), ...(trend.length > 1 ? { trend } : {}) };
};

export const chartToolBlocks = (args: unknown): BoundBlockView | null => {
  const parsed = parseCloudAiChartToolView(args);
  if (!parsed) return null;
  // The sign is not part of a chart's description, so it comes from the call's own arguments.
  const raw = args as { icon?: unknown; charts?: unknown };
  const signs =
    parsed.view === "chart"
      ? [raw.icon]
      : Array.isArray(raw.charts)
        ? raw.charts.map((chart) => (chart as { icon?: unknown } | null)?.icon)
        : [];
  const figures = (parsed.view === "chart" ? [parsed] : parsed.charts).map((chart, index) =>
    statItem(chart as Record<string, unknown>, signs[index]),
  );
  if (figures.every((figure) => figure !== null)) {
    const rows = Array.from({ length: Math.ceil(figures.length / 6) }, (_, index) => ({
      kind: "Stats" as const,
      items: (figures as StatItem[]).slice(index * 6, index * 6 + 6),
    }));
    return {
      version: 1,
      blocks:
        parsed.view === "group" && parsed.title
          ? [{ kind: "Section", title: parsed.title, ...(parsed.subtitle ? { description: parsed.subtitle } : {}), children: rows }]
          : rows,
    };
  }
  if (parsed.view === "chart") {
    const { view: _view, ...description } = parsed;
    return { version: 1, blocks: [{ kind: "Chart", description: gustavLine(description) }] };
  }
  const width = parsed.layout === "grid" ? ("half" as const) : undefined;
  const charts = parsed.charts.map((description) => ({
    kind: "Chart" as const,
    description: gustavLine(description),
    ...(width ? { width } : {}),
  }));
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
 * quiet line under it. Its icon is the small sign before the label, as every key figure has one; without a Tabler icon
 * name it takes the neutral sign (`figure-sign.ts`). Consecutive cards stand together in one row (`chat/turn-layout.ts`). The emoji has no place
 * in a key figure; the colour tone of the old card is left to the shared tiles.
 */
export const cardToolBlocks = (args: unknown): BoundBlockView | null => {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const card: Record<string, unknown> = Object.fromEntries(Object.entries(args));
  const label = cut(card.title);
  const value = cut(card.value);
  if (!label || !value) return null;
  const trend = [cut(card.trendValue, 40), cut(card.trendLabel, 40)].filter(Boolean).join(" ");
  const note = cut([trend, cut(card.caption)].filter(Boolean).join(" · "));
  return { version: 1, blocks: [{ kind: "Stats", items: [{ label, value, icon: figureSign(card.icon), ...(note ? { note } : {}) }] }] };
};
