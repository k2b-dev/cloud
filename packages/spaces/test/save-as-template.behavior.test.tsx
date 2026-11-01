import { describe, expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import type { SpaceItem } from "@/contracts";
import { createDomTestHarness } from "../../ui/test/dom";

if (!isServer)
  mock.module("@/api/client", () => ({ apiClient: { [":id"]: { "assignable-users": { $get: async () => Response.json([]) } } } }));

const lena = { id: "00000000-0000-4000-8000-000000000001", kind: "user" as const, displayName: "Lena H.", avatarHash: null };
const item = {
  id: "Itm001",
  spaceId: "Space1",
  columnId: "Col001",
  title: "Wochenbericht KW 44",
  description: null,
  priority: null,
  tags: [],
  assignees: [lena],
  // Friday 30 October 2026, 16:00 in Berlin.
  deadline: "2026-10-30T15:00:00.000Z",
  estimatedDurationMinutes: 30,
  startsAt: null,
  endsAt: null,
  allDay: false,
  location: null,
  url: null,
} as unknown as SpaceItem;
const checklist = ["Zahlen holen", "Bericht schicken"].map((label, index) => ({
  id: `Chk00${index}`,
  label,
  completed: index === 0,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
}));

describe("Save as template", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("fills the form from the item and replaces the week or the weekday only when the person says so", async () => {
    const dom = createDomTestHarness();
    const { TemplateForm } = await import("../src/frontend/[id]/_components/edit/TemplatesSection");
    const { templateFromItem } = await import("../src/frontend/[id]/_components/edit/template-from-item");
    const { LocaleProvider } = await import("@k2b/ui");
    const { draft, suggestions } = templateFromItem(item, {
      checklist,
      assigneesWithAccess: new Set([lena.id]),
      dateConfig: { locale: "de", timeZone: "Europe/Berlin" },
    });
    const saved: unknown[] = [];
    const dispose = render(
      () =>
        createComponent(LocaleProvider, {
          locale: "de",
          get children() {
            return createComponent(TemplateForm, {
              spaceId: "Space1",
              kind: draft.kind,
              draft,
              suggestions,
              tags: [],
              timeZone: "Europe/Berlin",
              loading: false,
              variant: "dialog",
              onCancel: () => {},
              onSave: (value) => saved.push(value),
            });
          },
        }),
      dom.root,
    );
    const text = () => dom.root.textContent ?? "";
    const button = (name: string) =>
      Array.from(dom.root.querySelectorAll("button")).find((candidate) => candidate.textContent?.trim() === name)!;
    const input = (value: string) => Array.from(dom.root.querySelectorAll("input")).find((candidate) => candidate.value === value);

    expect(input("Wochenbericht")).toBeDefined();
    expect(input("Wochenbericht KW 44")).toBeDefined();
    expect(text()).toContain("„KW 44“ durch {{week}} ersetzen, damit jede Woche passt?");
    expect(text()).toContain("War freitags fällig. Freitage vorschlagen?");
    expect(text()).toContain("Nicht übernommen: Datum, Kommentare, Anhänge, Verknüpfungen, erledigte Haken.");
    expect(text()).toContain("Ändern und Löschen: Space-Einstellungen › Vorlagen");

    button("Ersetzen").click();
    expect(input("Wochenbericht KW {{week}}")).toBeDefined();
    button("Rückgängig").click();
    expect(input("Wochenbericht KW 44")).toBeDefined();
    expect(text()).toContain("„KW 44“ bleibt fester Text.");
    button("Ja").click();
    expect(text()).toContain("Schlägt die nächsten Freitage vor.");

    dom.root.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    expect(saved).toEqual([
      expect.objectContaining({
        kind: "task",
        name: "Wochenbericht",
        icon: "ti ti-checkbox",
        title: "Wochenbericht KW 44",
        assigneeIds: [lena.id],
        checklist: ["Zahlen holen", "Bericht schicken"],
        estimatedDurationMinutes: 30,
        timeOfDay: "16:00",
        dateRule: { type: "weekdays", weekdays: ["FR"] },
      }),
    ]);
    dispose();
    dom.cleanup();
  });
});
