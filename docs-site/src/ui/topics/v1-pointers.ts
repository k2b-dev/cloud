import type { UiCatalogEntry } from "../catalog";
import { topics } from "./topics";

/** The v1 pages that belong to another topic than their section's (`section/slug` → topic slug). */
const pageTopics: Record<string, string> = {
  "actions/filters": "filter-sort-group",
  "actions/tabs": "frame",
  "actions/drag-and-drop": "lists-and-tables",
  "actions/sortable-list": "lists-and-tables",
  "layout/settings-modal": "dialogs-and-overlays",
  "layout/panel-dialog": "dialogs-and-overlays",
  "layout/bottom-sheet": "dialogs-and-overlays",
  "layout/anchored-popover": "dialogs-and-overlays",
  "layout/person-popover": "dialogs-and-overlays",
  "surfaces/empty-states": "states-and-notices",
  "feedback/toast": "dialogs-and-overlays",
  "feedback/tooltip": "dialogs-and-overlays",
  "feedback/hover-card": "dialogs-and-overlays",
  "feedback/prompts": "dialogs-and-overlays",
  "content/tables": "lists-and-tables",
  "content/pagination": "lists-and-tables",
  "content/load-more": "lists-and-tables",
  "content/activity-list": "lists-and-tables",
  "content/message-rows": "lists-and-tables",
  "content/virtual-feed": "lists-and-tables",
  "content/steps": "record-and-detail",
  "content/progress-path": "record-and-detail",
  "cloud/assistant-chat": "content",
};

/** The topic of each v1 section, where no page names its own. */
const sectionTopics: Record<string, string> = {
  ai: "content",
  input: "forms-and-input",
  actions: "actions-and-menus",
  layout: "frame",
  surfaces: "record-and-detail",
  feedback: "states-and-notices",
  content: "content",
  widgets: "content",
  cloud: "forms-and-input",
};

/** The v2 topic a v1 page points to. */
export const v2TopicFor = (section: string, slug: string) => {
  const target = pageTopics[`${section}/${slug}`] ?? sectionTopics[section] ?? "frame";
  const topic = topics.find((candidate) => candidate.slug === target);
  if (!topic) throw new Error(`v1 pointer: no v2 topic "${target}"`);
  return topic;
};

/** The line every v1 page starts with, in its HTML and in what search and MCP read. */
export const v1Pointer = (entry: Pick<UiCatalogEntry, "section" | "page">) => {
  const topic = v2TopicFor(entry.section, entry.page.slug);
  return `> **v1 (existing).** Apps still use this component, and it stays until v1 is removed. New screens use \`@k2b/ui/v2\`: see [${topic.parsed.title}](${topic.href}).`;
};
