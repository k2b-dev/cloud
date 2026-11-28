import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import { buttonNamed, fieldControl, installV2Globals, sendDialog } from "../../test/v2-dom";
import type { Space } from "../contracts";

if (isServer) {
  test.skip("Space creation uses browser conditions", () => {});
} else {
  const dom = createDomTestHarness();
  installV2Globals(dom);
  afterAll(() => dom.cleanup());
  const { LocaleProvider } = await import("@k2b/ui");
  const { default: CreateSpaceDialog } = await import("./_components/CreateSpaceDialog");
  const { overviewMessages } = await import("./overview-messages");
  const { readAllSettings, readSpaceSettings } = await import("./[id]/_components/settings/SpaceSettingsStore");
  const navigation = await import("@k2b/ssr/nav");
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method?: string; body: unknown }> = [];
  let respond: ((response: Response) => void) | undefined;
  let closed = 0;
  let dispose: (() => void) | undefined;
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
  const settle = () => Bun.sleep(10);
  const nameInput = () => fieldControl<HTMLInputElement>(dom, "Name")!;
  const descriptionInput = () =>
    dom.document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea') ?? fieldControl<HTMLTextAreaElement>(dom, "Description")!;
  const type = (control: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    control.value = value;
    control.dispatchEvent(new Event("input", { bubbles: true }));
  };
  /** Opens the starter select (the dialog's first field) and picks the starter with these words. */
  const selectTemplate = async (label: string) => {
    dom.document.querySelector<HTMLElement>('[role="dialog"] [data-k2-part="Field"] button')?.click();
    await settle();
    const option = [...dom.document.querySelectorAll<HTMLElement>('[role="option"]')].find((entry) => entry.textContent?.trim() === label);
    expect(option).toBeDefined();
    option?.click();
    await settle();
  };
  const start = async (locale: "en" | "de") => {
    dom.document.documentElement.lang = locale;
    const { t } = overviewMessages.resolve([locale]);
    dispose = render(
      () =>
        createComponent(LocaleProvider, {
          locale,
          get children() {
            return createComponent(CreateSpaceDialog, { open: true, onClose: () => void closed++ });
          },
        }),
      dom.root,
    );
    await settle();
    return t;
  };
  beforeEach(() => {
    dom.window.history.replaceState(null, "", "/app/spaces");
    requests.length = 0;
    respond = undefined;
    closed = 0;
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
    respond?.(Response.json({ message: "Cancelled test request" }, { status: 503 }));
    await settle();
    dispose?.();
    dispose = undefined;
    // A closing v2 dialog finishes its focus work a moment later, while the window still exists.
    await Bun.sleep(20);
    navigate.mockRestore();
    globalThis.fetch = originalFetch;
    dom.document.cookie = "settings-app-spaces=; Max-Age=0; Path=/";
  });

  describe("Space creation starter", () => {
    test.each(["en", "de"] as const)(
      "starts with the blank starter and empty fields, and saves its list view only after creation (%s)",
      async (locale) => {
        const t = await start(locale);
        expect(nameInput().value).toBe("");
        expect(descriptionInput().value).toBe("");
        type(nameInput(), "  Our work  ");
        sendDialog(dom);
        await settle();
        expect(requests[0]?.body).toEqual({ name: "Our work", color: "#3b82f6", starter: "blank" });
        expect(dom.document.cookie).not.toContain("settings-app-spaces");
        respond?.(Response.json(space));
        await settle();
        expect(readSpaceSettings(space.id).view).toBe("list");
        expect(readAllSettings().lastSpaceId).toBe(space.id);
        expect(navigate).toHaveBeenCalledWith("/app/spaces/Space1");
        expect(t.blankSpace.length).toBeGreaterThan(0);
      },
    );

    for (const locale of ["en", "de"] as const) {
      for (const starter of ["tasks", "calendar", "project"] as const) {
        test(`selected ${starter} fills localized fields and saves its view only after creation (${locale})`, async () => {
          const t = await start(locale);
          const expected = (
            {
              tasks: { name: t.taskBoard, description: t.taskBoardDescription, color: "#3b82f6", view: "kanban" },
              calendar: { name: t.eventCalendar, description: t.eventCalendarDescription, color: "#8b5cf6", view: "calendar" },
              project: { name: t.projectTracker, description: t.projectTrackerDescription, color: "#10b981", view: "table" },
            } as const
          )[starter];
          await selectTemplate(expected.name);
          expect(nameInput().value).toBe(expected.name);
          expect(descriptionInput().value).toBe(expected.description);
          sendDialog(dom);
          await settle();
          expect(requests).toHaveLength(1);
          expect(requests[0]?.url).toEndWith("/api/spaces");
          expect(requests[0]?.method).toBe("POST");
          expect(requests[0]?.body).toEqual({ name: expected.name, description: expected.description, color: expected.color, starter });
          expect(dom.document.cookie).not.toContain("settings-app-spaces");
          expect(navigate).not.toHaveBeenCalled();
          respond?.(Response.json({ ...space, name: expected.name, description: expected.description, color: expected.color }));
          await settle();
          expect(dom.document.cookie).toContain("settings-app-spaces=");
          expect(readSpaceSettings(space.id).view).toBe(expected.view);
          expect(readAllSettings().lastSpaceId).toBe(space.id);
          expect(navigate).toHaveBeenCalledWith("/app/spaces/Space1");
        });
      }
    }

    test("a starter keeps a name the person typed and fills only untouched fields", async () => {
      const t = await start("en");
      type(nameInput(), "Warehouse north");
      await selectTemplate(t.taskBoard);
      expect(nameInput().value).toBe("Warehouse north");
      expect(descriptionInput().value).toBe(t.taskBoardDescription);
      await selectTemplate(t.eventCalendar);
      expect(nameInput().value).toBe("Warehouse north");
      expect(descriptionInput().value).toBe(t.eventCalendarDescription);
      sendDialog(dom);
      await settle();
      expect(requests[0]?.body).toMatchObject({ name: "Warehouse north", color: "#8b5cf6", starter: "calendar" });
    });

    test("switching back to blank clears starter fields; cancelling writes nothing", async () => {
      const t = await start("en");
      await selectTemplate(t.projectTracker);
      expect(nameInput().value).toBe(t.projectTracker);
      await selectTemplate(t.blankSpace);
      expect(nameInput().value).toBe("");
      expect(descriptionInput().value).toBe("");
      buttonNamed(dom, t.cancel)!.click();
      await settle();
      expect(closed).toBe(1);
      expect(requests).toHaveLength(0);
      expect(dom.document.cookie).not.toContain("settings-app-spaces");
      expect(navigate).not.toHaveBeenCalled();
    });
  });
}
