import { expect, test } from "bun:test";
import type { DropdownAction, DropdownItem, DropdownSection } from "@k2b/ui";
import type { PageTemplateSummary } from "@/lib/page-templates";
import { notebookWorkspaceMessages } from "../../messages";
import { type NewNoteMenuChoice, newNoteMenuModel, TEMPLATE_MENU_SEARCH_FROM } from "./page-template-menu";

const template = (id: string, name: string, builtIn = false): PageTemplateSummary => ({
  id,
  name,
  description: builtIn ? `${name} sections` : null,
  icon: builtIn ? "ti ti-users" : "ti ti-template",
  builtIn,
  updatedAt: builtIn ? null : "2026-11-01T10:00:00.000Z",
});
const builtIns = [template("meeting-notes", "Meeting notes", true), template("project-page", "Project page", true)];
const labels = (items: readonly DropdownItem[]) =>
  items.map((item) => ("items" in item ? [item.sectionLabel ?? "", item.items.map((row) => row.label)] : item.label));

const model = (templates: PageTemplateSummary[], locale = "en") => {
  const chosen: NewNoteMenuChoice[] = [];
  const { t } = notebookWorkspaceMessages.resolve([locale]);
  return { chosen, ...newNoteMenuModel({ templates, t, choose: (choice) => chosen.push(choice) }) };
};

test("a blank note comes first, so Enter twice still makes one; own templates come before the built-in ones", () => {
  const menu = model([template("Own123", "Weekly"), ...builtIns]);
  expect(labels(menu.items)).toEqual([
    "Blank note",
    ["Templates of this notebook", ["Weekly"]],
    ["Built-in templates", ["Meeting notes", "Project page"]],
    ["", ["Manage templates…"]],
  ]);
  (menu.items[0] as DropdownAction).action?.();
  ((menu.items[1] as DropdownSection).items[0] as DropdownAction).action?.();
  ((menu.items[3] as DropdownSection).items[0] as DropdownAction).action?.();
  expect(menu.chosen).toEqual([{ type: "blank" }, { type: "template", template: template("Own123", "Weekly") }, { type: "manage" }]);
  expect(menu.search).toBeUndefined();
});

test("without own templates the menu names only the built-in ones, in German too", () => {
  expect(labels(model(builtIns, "de").items)).toEqual([
    "Leere Notiz",
    ["Eingebaute Vorlagen", ["Meeting notes", "Project page"]],
    ["", ["Vorlagen verwalten …"]],
  ]);
});

test("a long list gets a search field that counts the matches", () => {
  const many = Array.from({ length: TEMPLATE_MENU_SEARCH_FROM - builtIns.length }, (_, index) => template(`Own${index}00`, `Own ${index}`));
  const menu = model([...many, ...builtIns], "de");
  expect(menu.search?.label).toBe("Vorlagen suchen");
  expect(menu.search?.status?.("own", 3)).toBe("3 Vorlagen passen");
  expect(menu.search?.status?.("zzz", 0)).toBe("Keine Vorlage passt");
  expect(model([...many.slice(1), ...builtIns]).search).toBeUndefined();
});
