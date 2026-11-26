// The topic files in their order, with their slug and title only: no build-time data, so the catalog check and the
// v1 pointers can read them in any environment.
import actionsAndMenus from "./actions-and-menus.md" with { type: "text" };
import content from "./content.md" with { type: "text" };
import dialogsAndOverlays from "./dialogs-and-overlays.md" with { type: "text" };
import filterSortGroup from "./filter-sort-group.md" with { type: "text" };
import formsAndInput from "./forms-and-input.md" with { type: "text" };
import frame from "./frame.md" with { type: "text" };
import identity from "./identity.md" with { type: "text" };
import listsAndTables from "./lists-and-tables.md" with { type: "text" };
import recordAndDetail from "./record-and-detail.md" with { type: "text" };
import statesAndNotices from "./states-and-notices.md" with { type: "text" };

/**
 * The topics of the UI section in their order: what a screen does, not which component it uses. Each topic is one
 * Markdown file beside this one, owned by whoever writes it; its URL is `/en/ui/v2/<slug>`.
 */
export const topicFiles = [
  ["frame", frame],
  ["lists-and-tables", listsAndTables],
  ["identity", identity],
  ["filter-sort-group", filterSortGroup],
  ["record-and-detail", recordAndDetail],
  ["forms-and-input", formsAndInput],
  ["actions-and-menus", actionsAndMenus],
  ["dialogs-and-overlays", dialogsAndOverlays],
  ["states-and-notices", statesAndNotices],
  ["content", content],
] as const;

/** The title of a topic file: its `# …` line. */
const titleOf = (markdown: string) => markdown.match(/^# (.+)$/m)?.[1]?.trim() ?? "";

/** Every topic by slug with its title and address, in order. */
export const topicIndex = topicFiles.map(([slug, source], index) => ({
  slug,
  number: index + 1,
  title: titleOf(source),
  href: `/en/ui/v2/${slug}`,
}));
