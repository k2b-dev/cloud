import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import type { Space } from "../contracts";

if (isServer) {
  test.skip("Space creation uses browser conditions", () => {});
} else {
  const dom = createDomTestHarness();
  afterAll(() => dom.cleanup());
  const { createSpaceCreation } = await import("./create-space-dialog");
  const { overviewMessages } = await import("./overview-messages");
  const { readAllSettings, readSpaceSettings } = await import("./[id]/_components/settings/SpaceSettingsStore");
  const navigation = await import("@k2b/ssr/nav");
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method?: string; body: unknown }> = [];
  let respond: ((response: Response) => void) | undefined;
  let opening: Promise<void> | undefined;
  let navigate: ReturnType<typeof spyOn<typeof navigation, "navigateTo">>;
  const space: Space = {
    id: "Space1",
    name: "Created space",
    description: null,
    color: "#3b82f6",
    icalToken: null,
    createdAt: "2026-10-19T12:00:00.000Z",
    updatedAt: "2026-10-19T12:00:00.000Z",
  };
  const clickButton = (label: string) => {
    const button = Array.from(dom.document.querySelectorAll<HTMLButtonElement>("button")).find(
      (entry) => entry.textContent?.trim() === label,
    );
    expect(button).toBeDefined();
    button?.click();
  };
  const form = () => {
    const element = dom.document.querySelector<HTMLFormElement>("dialog form");
    expect(element).not.toBeNull();
    return element!;
  };
  const nameInput = () => form().querySelector<HTMLInputElement>('input[type="text"]')!;
  const descriptionInput = () => form().querySelector<HTMLTextAreaElement>("textarea")!;
  const colorInput = () => form().querySelector<HTMLInputElement>('input[type="color"]')!;
  const selectTemplate = (label: string) => {
    form().querySelector<HTMLButtonElement>('[role="combobox"]')?.click();
    const option = Array.from(dom.document.querySelectorAll<HTMLButtonElement>('[role="option"]')).find(
      (entry) => entry.getAttribute("aria-label") === label,
    );
    expect(option).toBeDefined();
    option?.click();
  };
  const start = (locale: "en" | "de") => {
    dom.document.documentElement.lang = locale;
    const { t } = overviewMessages.resolve([locale]);
    opening = createSpaceCreation(t)();
    return t;
  };
  beforeEach(() => {
    dom.window.history.replaceState(null, "", "/app/spaces");
    requests.length = 0;
    respond = undefined;
    opening = undefined;
    navigate = spyOn(navigation, "navigateTo").mockImplementation(() => {});
    globalThis.fetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(input), method: init?.method, body: JSON.parse(String(init?.body)) });
        return new Promise<Response>((resolve) => {
          respond = resolve;
        });
      },
      { preconnect: originalFetch.preconnect },
    );
  });
  afterEach(async () => {
    // A failed assertion must also close the real dialog and settle its caller.
    respond?.(Response.json({ message: "Cancelled test request" }, { status: 503 }));
    await Promise.resolve();
    await Promise.resolve();
    if (dom.document.querySelector("dialog form")) {
      const { t } = overviewMessages.resolve([dom.document.documentElement.lang]);
      clickButton(t.cancel);
    }
    await opening;
    navigate.mockRestore();
    globalThis.fetch = originalFetch;
    dom.document.cookie = "settings-app-spaces=; Max-Age=0; Path=/";
  });

  describe("Space creation template picker", () => {
    test.each(["en", "de"] as const)("starts with the blank template and empty fields (%s)", async (locale) => {
      const t = start(locale);
      expect(form().querySelector('[role="combobox"]')?.textContent).toContain(t.blankSpace);
      expect(nameInput().value).toBe("");
      expect(descriptionInput().value).toBe("");
      expect(colorInput().value).toBe("#3b82f6");
      form().querySelector<HTMLButtonElement>('[role="combobox"]')?.click();
      expect(Array.from(dom.document.querySelectorAll('[role="option"]')).map((option) => option.getAttribute("aria-label"))).toEqual([
        t.blankSpace,
        t.taskBoard,
        t.eventCalendar,
        t.projectTracker,
      ]);
      expect(dom.document.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain(t.blankSpaceDescription);
      selectTemplate(t.blankSpace);
      nameInput().value = "  Our work  ";
      nameInput().dispatchEvent(new Event("input", { bubbles: true }));
      form().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      expect(requests[0]?.body).toEqual({ name: "Our work", color: "#3b82f6", starter: "blank" });
      expect(dom.document.cookie).not.toContain("settings-app-spaces");
      respond?.(Response.json(space));
      await opening;
      expect(readSpaceSettings(space.id).view).toBe("list");
      expect(readAllSettings().lastSpaceId).toBe(space.id);
      expect(navigate).toHaveBeenCalledWith("/app/spaces/Space1");
    });

    for (const locale of ["en", "de"] as const) {
      for (const starter of ["tasks", "calendar", "project"] as const) {
        test(`selected ${starter} fills localized fields and saves its view only after creation (${locale})`, async () => {
          const t = start(locale);
          const expected = (
            {
              tasks: { name: t.taskBoard, description: t.taskBoardDescription, color: "#3b82f6", view: "kanban" },
              calendar: { name: t.eventCalendar, description: t.eventCalendarDescription, color: "#8b5cf6", view: "calendar" },
              project: { name: t.projectTracker, description: t.projectTrackerDescription, color: "#10b981", view: "table" },
            } as const
          )[starter];
          selectTemplate(expected.name);
          expect(nameInput().value).toBe(expected.name);
          expect(descriptionInput().value).toBe(expected.description);
          expect(colorInput().value).toBe(expected.color);
          form().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
          expect(requests).toHaveLength(1);
          expect(requests[0]?.url).toEndWith("/api/spaces");
          expect(requests[0]?.method).toBe("POST");
          expect(requests[0]?.body).toEqual({
            name: expected.name,
            description: expected.description,
            color: expected.color,
            starter,
          });
          expect(dom.document.cookie).not.toContain("settings-app-spaces");
          expect(navigate).not.toHaveBeenCalled();
          respond?.(Response.json({ ...space, name: expected.name, description: expected.description, color: expected.color }));
          await opening;
          expect(dom.document.cookie).toContain("settings-app-spaces=");
          expect(readSpaceSettings(space.id).view).toBe(expected.view);
          expect(readAllSettings().lastSpaceId).toBe(space.id);
          expect(navigate).toHaveBeenCalledWith("/app/spaces/Space1");
        });
      }
    }

    test("a template keeps a name the person typed and fills only untouched fields", async () => {
      const t = start("en");
      nameInput().value = "Warehouse north";
      nameInput().dispatchEvent(new Event("input", { bubbles: true }));
      selectTemplate(t.taskBoard);
      expect(nameInput().value).toBe("Warehouse north");
      expect(descriptionInput().value).toBe(t.taskBoardDescription);
      selectTemplate(t.eventCalendar);
      expect(nameInput().value).toBe("Warehouse north");
      expect(descriptionInput().value).toBe(t.eventCalendarDescription);
      expect(colorInput().value).toBe("#8b5cf6");
      clickButton(t.cancel);
      await opening;
    });

    test("switching back to blank clears starter fields; cancelling writes nothing", async () => {
      const t = start("en");
      selectTemplate(t.projectTracker);
      expect(nameInput().value).toBe(t.projectTracker);
      selectTemplate(t.blankSpace);
      expect(nameInput().value).toBe("");
      expect(descriptionInput().value).toBe("");
      expect(colorInput().value).toBe("#3b82f6");
      clickButton(t.cancel);
      await opening;
      expect(requests).toHaveLength(0);
      expect(dom.document.cookie).not.toContain("settings-app-spaces");
      expect(navigate).not.toHaveBeenCalled();
    });
  });
}
