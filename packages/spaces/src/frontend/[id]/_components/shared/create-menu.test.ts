import { describe, expect, test } from "bun:test";
import type { DropdownAction, DropdownItem, DropdownSection } from "@k2b/ui";
import { MAX_ITEM_TEMPLATES_PER_KIND, type SpaceItemTemplate } from "@/contracts";
import { spaceMessages } from "../../messages";
import { type CreateMenuChoice, createMenuModel, createMenuPopup, templateHint } from "./create-menu";

const t = spaceMessages.resolve(["de"]).t;
const stamps = { spaceId: "Space1", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" };
const template = (id: string, name: string, patch: Partial<SpaceItemTemplate> = {}): SpaceItemTemplate => ({
  ...stamps,
  id,
  kind: "task",
  name,
  icon: null,
  title: name,
  description: null,
  priority: null,
  tags: [],
  assignees: [],
  assignCreator: false,
  checklist: [],
  estimatedDurationMinutes: null,
  location: null,
  url: null,
  allDay: false,
  durationMinutes: null,
  timeOfDay: null,
  dateRule: { type: "none" },
  ...patch,
});
const weekly = template("Tpl001", "Wochenbericht", {
  icon: "ti ti-report",
  checklist: ["a", "b", "c"],
  dateRule: { type: "weekdays", weekdays: ["FR"] },
});
const complaint = template("Tpl002", "Reklamation", {
  priority: "high",
  tags: [{ id: "Tag001", spaceId: "Space1", name: "Kunde", color: "#e11d48" }],
  dateRule: { type: "offset", days: 2 },
});
const visit = template("Tpl003", "Kundentermin", { kind: "event", timeOfDay: "10:00", durationMinutes: 60, location: "Halle 2" });

const labels = (items: readonly DropdownItem[]) =>
  items.map((item) => ("items" in item ? { [item.sectionLabel ?? ""]: item.items.map((entry) => entry.label) } : item.label));
const model = (kind: "task" | "event" | "calendar", templates: SpaceItemTemplate[], chosen: CreateMenuChoice[] = []) =>
  createMenuModel({ kind, templates, shortcuts: true, t, locale: "de", choose: (choice) => chosen.push(choice) });

describe("the + menu", () => {
  test("offers blank first, then the kind's templates, then Create template", () => {
    const chosen: CreateMenuChoice[] = [];
    const { items, search, label } = model("task", [weekly, complaint, visit], chosen);
    expect(label).toBe("Neue Aufgabe");
    expect(labels(items)).toEqual(["Leere Aufgabe", { Vorlagen: ["Wochenbericht", "Reklamation"] }, "Vorlage erstellen …"]);
    expect(search).toBeUndefined();
    (items[0] as DropdownAction).action?.();
    ((items[1] as DropdownSection).items[0] as DropdownAction).action?.();
    (items[2] as DropdownAction).action?.();
    expect(chosen).toEqual([
      { type: "blank", kind: "task" },
      { type: "template", template: weekly },
      { type: "create-template", kind: "task" },
    ]);
  });

  test("the calendar offers both blanks and both kinds of templates, events first", () => {
    const { items, label } = model("calendar", [weekly, visit]);
    expect(label).toBe("Neu im Kalender");
    expect(labels(items)).toEqual([
      "Leerer Termin",
      "Leere Aufgabe mit Frist",
      { Terminvorlagen: ["Kundentermin"] },
      { Aufgabenvorlagen: ["Wochenbericht"] },
      "Vorlage erstellen …",
    ]);
  });

  test("without templates, Create template says what templates do", () => {
    const { items } = model("task", []);
    expect(labels(items)).toEqual(["Leere Aufgabe", "Vorlage erstellen …"]);
    expect((items[1] as DropdownAction).description).toBe("Vorlagen füllen Titel, Tags, Checkliste und Datum vor.");
  });

  test("at the limit, Create template is disabled and says why", () => {
    const full = Array.from({ length: MAX_ITEM_TEMPLATES_PER_KIND }, (_, index) =>
      template(`T${String(index).padStart(5, "0")}`, `T${index}`),
    );
    const create = model("task", full).items.at(-1) as DropdownAction;
    expect(create.disabled).toBe(true);
    expect(create.description).toBe(`Ein Space hat höchstens ${MAX_ITEM_TEMPLATES_PER_KIND} Vorlagen je Art.`);
  });

  test("templates show their icon and what they fill in", () => {
    const rows = (model("task", [weekly, complaint]).items[1] as DropdownSection).items as DropdownAction[];
    expect(rows.map((row) => [row.icon, row.description])).toEqual([
      ["ti ti-report", "nächster Fr · Checkliste 3"],
      ["ti ti-checkbox", "+2 Tage · Hoch · Kunde"],
    ]);
    expect(templateHint(visit, t, "de")).toBe("60 Min · 10:00 · Ort Halle 2");
  });

  test("from eight templates on, a search finds them and a query without a match becomes the title", () => {
    const many = ["Inventur", "Tourenplan", "Rechnung prüfen", "Onboarding", "Angebot einholen", "Urlaubsübergabe"].map((name, index) =>
      template(`Tpl1${index}0`, name),
    );
    const chosen: CreateMenuChoice[] = [];
    const { search } = model("task", [weekly, complaint, ...many], chosen);
    expect(search?.label).toBe("Vorlage suchen");
    expect(labels(search!.filter!("rek"))).toEqual([{ Vorlagen: ["Reklamation"] }, { "Ohne Vorlage": ["Leere Aufgabe „rek“"] }]);
    expect(search!.status!("rek", 2)).toBe("1 Vorlage passt");
    const none = search!.filter!("Palette tauschen");
    expect(labels(none)).toEqual(["Leere Aufgabe „Palette tauschen“"]);
    expect((none[0] as DropdownAction).description).toBe("Keine Vorlage passt · Enter legt mit diesem Titel an");
    (none[0] as DropdownAction).action?.();
    expect(chosen).toEqual([{ type: "blank", kind: "task", title: "Palette tauschen" }]);
    expect(search!.status!("Palette tauschen", 1)).toBe("Keine Vorlage passt");
    expect(createMenuPopup("task", [weekly, complaint, ...many])).toBe("dialog");
    expect(createMenuPopup("event", [weekly, complaint, ...many])).toBe("menu");
  });
});
