import { type DropdownAction, type DropdownItem, type DropdownSearch, Kbd } from "@k2b/ui";
import { createComponent } from "solid-js";
import { type ItemTemplateKind, MAX_ITEM_TEMPLATES_PER_KIND, type SpaceItemTemplate, type TemplateWeekday } from "@/contracts";
import type { useSpaceMessages } from "../../messages";
import { priorityOptions } from "./item-form/options";
import type { ItemType } from "./item-form/types";

type Messages = ReturnType<typeof useSpaceMessages>;

/** What a "+" makes: tasks, events, or both from the calendar. */
export type CreateMenuKind = "task" | "event" | "calendar";

/** What a person chose in the menu. */
export type CreateMenuChoice =
  | { type: "blank"; kind: ItemType; title?: string }
  | { type: "template"; template: SpaceItemTemplate }
  | { type: "create-template"; kind: ItemTemplateKind };

/** From this many templates on, the menu gets a search field. */
export const CREATE_MENU_SEARCH_FROM = 8;

/** Whether the menu for `kind` gets a search field, which makes its popup a dialog. */
export const createMenuPopup = (kind: CreateMenuKind, templates: readonly Pick<SpaceItemTemplate, "kind">[]): "menu" | "dialog" =>
  templates.filter((template) => kind === "calendar" || template.kind === kind).length >= CREATE_MENU_SEARCH_FROM ? "dialog" : "menu";

const WEEKDAY_INDEX: Record<TemplateWeekday, number> = { MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6 };

/** A short weekday such as "Fr" or "Fri", without the abbreviation dot. */
export const shortWeekday = (day: TemplateWeekday, locale: string): string =>
  new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" })
    .format(new Date(Date.UTC(2024, 0, 1 + WEEKDAY_INDEX[day], 12)))
    .replace(/\.$/, "");

/** The template's default icon: a checkbox for tasks, a calendar for events. */
export const templateIcon = (template: Pick<SpaceItemTemplate, "icon" | "kind">): string =>
  template.icon ?? (template.kind === "event" ? "ti ti-calendar-event" : "ti ti-checkbox");

/** One quiet line of what a template fills in, such as "next Fri · checklist 3" or "60 min · 10:00". */
export const templateHint = (template: SpaceItemTemplate, t: Messages, locale: string): string => {
  const rule = template.dateRule;
  const day =
    rule.type === "offset"
      ? rule.days === 0
        ? t.templateHintToday
        : t.templateHintInDays({ days: rule.days })
      : rule.type === "weekdays"
        ? rule.weekdays.length === 1
          ? t.templateHintNext({ day: shortWeekday(rule.weekdays[0]!, locale) })
          : rule.weekdays.map((weekday) => shortWeekday(weekday, locale)).join(", ")
        : undefined;
  const time = template.allDay ? undefined : (template.timeOfDay ?? undefined);
  const parts =
    template.kind === "event"
      ? [
          template.allDay ? t.templateHintAllDay : t.templateHintMinutes({ count: template.durationMinutes ?? 60 }),
          day,
          time,
          template.location ? t.templateHintPlace({ place: template.location }) : undefined,
        ]
      : [
          day,
          time,
          template.priority === "high" || template.priority === "urgent"
            ? priorityOptions(locale).find((option) => option.id === template.priority)?.label
            : undefined,
          template.tags[0]?.name,
          template.checklist.length ? t.templateHintChecklist({ count: template.checklist.length }) : undefined,
        ];
  return parts.filter(Boolean).join(" · ");
};

/** A menu row for a template: its icon, its name, and what it fills in. */
export const templateMenuRow = (
  template: SpaceItemTemplate,
  t: Messages,
  locale: string,
  choose: (template: SpaceItemTemplate) => void,
): DropdownAction => ({
  label: template.name,
  icon: templateIcon(template),
  description: templateHint(template, t, locale) || undefined,
  action: () => choose(template),
});

/** The calendar's template sections, event templates first, as its "+" and its day menu show them. */
export const calendarTemplateSections = (
  templates: readonly SpaceItemTemplate[],
  t: Messages,
  locale: string,
  choose: (template: SpaceItemTemplate) => void,
): DropdownItem[] =>
  (["event", "task"] as const).flatMap((kind) => {
    const list = templates.filter((template) => template.kind === kind);
    return list.length
      ? [
          {
            sectionLabel: kind === "event" ? t.createMenuEventTemplates : t.createMenuTaskTemplates,
            items: list.map((template) => templateMenuRow(template, t, locale, choose)),
          },
        ]
      : [];
  });

/**
 * The one menu behind every "+": blank first, then the templates, then "Create template…". With many templates a search
 * field finds one, and a query no template matches becomes the blank item's title.
 */
export const createMenuModel = (options: {
  kind: CreateMenuKind;
  templates: readonly SpaceItemTemplate[];
  /** Shows the N and Shift+N shortcuts beside the blank entries, where those keys create directly. */
  shortcuts?: boolean;
  t: Messages;
  locale: string;
  choose: (choice: CreateMenuChoice) => void;
}): { items: DropdownItem[]; search?: DropdownSearch; label: string } => {
  const { t, kind, choose } = options;
  const kinds: ItemTemplateKind[] = kind === "calendar" ? ["event", "task"] : [kind];
  const templatesOf = (of: ItemTemplateKind) => options.templates.filter((template) => template.kind === of);
  const shown = kinds.flatMap(templatesOf);
  const blankLabel = (of: ItemType) => (of === "event" ? t.createMenuBlankEvent : t.createMenuBlankTask);
  const blank = (of: ItemType, label: string, keys?: string): DropdownAction => ({
    label,
    icon: "ti ti-plus",
    variant: "accent",
    trailing: options.shortcuts && keys ? createComponent(Kbd, { keys }) : undefined,
    action: () => choose({ type: "blank", kind: of }),
  });
  const templateRow = (template: SpaceItemTemplate) =>
    templateMenuRow(template, t, options.locale, () => choose({ type: "template", template }));
  const sectionLabel = (of: ItemTemplateKind) =>
    kind !== "calendar" ? t.createMenuTemplates : of === "event" ? t.createMenuEventTemplates : t.createMenuTaskTemplates;
  const sections = (list: (of: ItemTemplateKind) => SpaceItemTemplate[]) =>
    kinds.flatMap((of) => (list(of).length ? [{ sectionLabel: sectionLabel(of), items: list(of).map(templateRow) }] : []));
  // The calendar creates either kind, so its "Create template…" makes an event template, the kind it opens with.
  const createKind: ItemTemplateKind = kind === "task" ? "task" : "event";
  const full = templatesOf(createKind).length >= MAX_ITEM_TEMPLATES_PER_KIND;
  const create: DropdownAction = full
    ? {
        label: t.createMenuCreateTemplate,
        icon: "ti ti-template",
        disabled: true,
        description: t.createMenuLimit({ count: MAX_ITEM_TEMPLATES_PER_KIND }),
      }
    : {
        label: t.createMenuCreateTemplate,
        icon: "ti ti-template",
        description: shown.length ? undefined : t.createMenuEmptyHint,
        action: () => choose({ type: "create-template", kind: createKind }),
      };

  const blanks =
    kind === "calendar"
      ? [blank("event", t.createMenuBlankEvent, "n"), blank("task", t.createMenuBlankTaskWithDeadline, "shift+n")]
      : [blank(kind, blankLabel(kind), "n")];
  const items: DropdownItem[] = [...blanks, ...sections(templatesOf), create];
  const label = kind === "calendar" ? t.createMenuCalendar : kind === "event" ? t.newEvent : t.newTask;
  if (shown.length < CREATE_MENU_SEARCH_FROM) return { items, label };

  const blankKind: ItemType = kind === "task" ? "task" : "event";
  const matching = (query: string) => {
    const needle = query.trim().toLocaleLowerCase(options.locale);
    return (of: ItemTemplateKind) => templatesOf(of).filter((template) => template.name.toLocaleLowerCase(options.locale).includes(needle));
  };
  const count = (query: string) => kinds.flatMap(matching(query)).length;
  return {
    items,
    label,
    search: {
      label: t.createMenuSearch,
      filter: (query) => {
        const title = query.trim();
        const found = sections(matching(query));
        const titled: DropdownAction = {
          label: blankKind === "event" ? t.createMenuBlankEventTitled({ title }) : t.createMenuBlankTaskTitled({ title }),
          icon: "ti ti-plus",
          variant: "accent",
          description: found.length ? undefined : t.createMenuNoMatch,
          action: () => choose({ type: "blank", kind: blankKind, title }),
        };
        return found.length ? [...found, { sectionLabel: t.createMenuWithoutTemplate, items: [titled] }] : [titled];
      },
      status: (query) => t.createMenuMatches({ count: count(query) }),
    },
  };
};
