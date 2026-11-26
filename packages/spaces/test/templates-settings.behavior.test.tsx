import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import type { SpaceItemTemplate } from "@/contracts";
import { createDomTestHarness } from "../../ui/test/dom";
import { browserTimeZone } from "../src/frontend/[id]/_components/shared/item-form/templates";
import { formatTemplateDate, localNow } from "../src/presentation/item-templates";
import { installV2Globals } from "./v2-dom";

const today: SpaceItemTemplate = {
  id: "Tpl001",
  spaceId: "Space1",
  kind: "task",
  name: "Daily log",
  title: "Log {{date}}",
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
  dateRule: { type: "offset", days: 0 },
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

describe("Spaces template settings", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("the proposal preview uses the person's Cloud time zone, as the new item dialog does", async () => {
    const now = new Date();
    // These zones are 25 hours apart, so at least one of them is on another day than this machine.
    const timeZone = ["Pacific/Kiritimati", "Pacific/Pago_Pago"].find(
      (zone) => localNow(now, zone).date !== localNow(now, browserTimeZone()).date,
    )!;
    const dom = createDomTestHarness();
    installV2Globals(dom);
    const { TemplatesSection } = await import("../src/frontend/[id]/_components/edit/TemplatesSection");
    const dispose = render(
      () =>
        createComponent(TemplatesSection, {
          spaceId: "Space1",
          templates: [today],
          tags: [],
          dateConfig: { timeZone, locale: "en" },
          onDirtyChange: () => undefined,
        }),
      dom.root,
    );
    // A template's row opens it.
    dom.document.querySelector<HTMLButtonElement>('[data-k2-part="Row"] button.k2-row-open')!.click();
    expect(dom.document.body.textContent).toContain(`Next proposals: ${formatTemplateDate(localNow(now, timeZone).date, "en")}`);
    dispose();
    // A closing v2 dialog finishes its focus work a moment later, while the window still exists.
    await Bun.sleep(20);
    dom.cleanup();
  });
});
