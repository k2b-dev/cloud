import actionsAndMenus from "./actions-and-menus.md" with { type: "text" };
import content from "./content.md" with { type: "text" };
import dialogsAndOverlays from "./dialogs-and-overlays.md" with { type: "text" };
import filterSortGroup from "./filter-sort-group.md" with { type: "text" };
import formsAndInput from "./forms-and-input.md" with { type: "text" };
import frame from "./frame.md" with { type: "text" };
import listsAndTables from "./lists-and-tables.md" with { type: "text" };
import recordAndDetail from "./record-and-detail.md" with { type: "text" };
import statesAndNotices from "./states-and-notices.md" with { type: "text" };
import { type ParsedTopic, parseTopic, topicMarkdown, topicParts, topicSummary } from "./topic-markdown";

/**
 * The topics of the UI section in their order: what a screen does, not which component it uses. Each topic is one
 * Markdown file beside this one, owned by whoever writes it; its URL is `/en/ui/v2/<slug>`.
 */
const files = [
  ["frame", frame],
  ["lists-and-tables", listsAndTables],
  ["filter-sort-group", filterSortGroup],
  ["record-and-detail", recordAndDetail],
  ["forms-and-input", formsAndInput],
  ["actions-and-menus", actionsAndMenus],
  ["dialogs-and-overlays", dialogsAndOverlays],
  ["states-and-notices", statesAndNotices],
  ["content", content],
] as const;

export type Topic = {
  slug: string;
  number: number;
  path: string;
  href: string;
  parsed: ParsedTopic;
  /** The first sentence of the lead. */
  summary: string;
  parts: string[];
  /** The Markdown twin for search, `read_doc` and llms.txt. */
  markdown: string;
};

export const topics: readonly Topic[] = files.map(([slug, source], index) => {
  const parsed = parseTopic(source);
  return {
    slug,
    number: index + 1,
    path: `/v2/${slug}`,
    href: `/en/ui/v2/${slug}`,
    parsed,
    summary: topicSummary(parsed),
    parts: topicParts(parsed),
    markdown: topicMarkdown(source),
  };
});

/** The raw files, for the shape test. */
export const topicFiles: readonly (readonly [string, string])[] = files;
