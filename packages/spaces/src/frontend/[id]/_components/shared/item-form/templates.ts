import type { SpaceItemTemplate } from "@/contracts";
import type { TemplateDraftSource } from "@/presentation/item-templates";

/** The template choice that means "start empty". Template IDs are six characters, so it never collides. */
export const BLANK_TEMPLATE = "blank";
/** Up to this many templates show as chips; more open a searchable list instead. */
export const MAX_TEMPLATE_CHIPS = 6;
export const OTHER_DATE = "other";
export const NO_DATE = "none";

export const templateDraftSource = (template: SpaceItemTemplate): TemplateDraftSource => ({
  ...template,
  tagIds: template.tags.map((tag) => tag.id),
  assigneeIds: template.assignees.map((assignee) => assignee.id),
});

/** The browser's zone when the request carried none, so proposals still follow the person's calendar. */
export const browserTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;
