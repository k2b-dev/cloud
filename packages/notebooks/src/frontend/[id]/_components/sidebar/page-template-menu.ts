import type { DropdownAction, DropdownItem, DropdownSearch } from "@k2b/ui";
import type { PageTemplateSummary } from "@/lib/page-templates";
import type { notebookWorkspaceMessages } from "../../messages";

type Messages = ReturnType<(typeof notebookWorkspaceMessages)["resolve"]>["t"];

/** From this many templates on, the menu gets a search field, as the Spaces "+" menu does. */
export const TEMPLATE_MENU_SEARCH_FROM = 8;

/** A menu row for a template: its icon, its name, and for built-in ones what they hold. */
export const templateMenuRow = (template: PageTemplateSummary, choose: (template: PageTemplateSummary) => void): DropdownAction => ({
  label: template.name,
  icon: template.icon,
  description: template.description ?? undefined,
  action: () => choose(template),
});

/** The notebook's own templates, then the built-in ones, each under its heading. */
export const templateMenuSections = (
  templates: readonly PageTemplateSummary[],
  t: Messages,
  choose: (template: PageTemplateSummary) => void,
): DropdownItem[] => {
  const own = templates.filter((template) => !template.builtIn);
  const builtIn = templates.filter((template) => template.builtIn);
  return [
    ...(own.length ? [{ sectionLabel: t.ownTemplates, items: own.map((template) => templateMenuRow(template, choose)) }] : []),
    ...(builtIn.length ? [{ sectionLabel: t.builtInTemplates, items: builtIn.map((template) => templateMenuRow(template, choose)) }] : []),
  ];
};

/** A search field once the list is long; its count speaks in the person's language. */
export const templateMenuSearch = (templates: readonly PageTemplateSummary[], t: Messages): DropdownSearch | undefined =>
  templates.length >= TEMPLATE_MENU_SEARCH_FROM
    ? { label: t.searchTemplates, status: (_, matches) => (matches ? t.templateMatches({ count: matches }) : t.noTemplateMatch) }
    : undefined;

export type NewNoteMenuChoice = { type: "blank" } | { type: "template"; template: PageTemplateSummary } | { type: "manage" };

/**
 * The menu behind the "new note" button: a blank note first, so Enter twice keeps making one, then the templates, then
 * "Manage templates…".
 */
export const newNoteMenuModel = (options: {
  templates: readonly PageTemplateSummary[];
  t: Messages;
  choose: (choice: NewNoteMenuChoice) => void;
}): { items: DropdownItem[]; search?: DropdownSearch } => {
  const { t, choose } = options;
  return {
    items: [
      { label: t.blankNote, icon: "ti ti-file-plus", variant: "accent", action: () => choose({ type: "blank" }) },
      ...templateMenuSections(options.templates, t, (template) => choose({ type: "template", template })),
      { items: [{ label: t.manageTemplates, icon: "ti ti-settings", action: () => choose({ type: "manage" }) }] },
    ],
    search: templateMenuSearch(options.templates, t),
  };
};
