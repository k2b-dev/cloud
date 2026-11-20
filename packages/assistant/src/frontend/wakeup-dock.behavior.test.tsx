import { afterAll, expect, test } from "bun:test";
import type { AiWakeup } from "@k2b/cloud/ai";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

// One document for the whole file: Solid delegates clicks to the document that existed when the component loaded.
const dom = createDomTestHarness();
const { LocaleProvider } = await import("@k2b/ui");
const { default: AssistantWakeupDock } = await import("./wakeup-dock");
const cleanup: (() => void)[] = [];
afterAll(() => {
  for (const stop of cleanup.splice(0).reverse()) stop();
  dom.cleanup();
});

const alarm = (id: string, note: string): AiWakeup => ({
  id,
  at: "2026-11-16T15:00:00.000Z",
  cron: null,
  timezone: "Europe/Berlin",
  endsAt: null,
  note,
  noteSource: { kind: "person", userId: "6f9619ff-8b86-4d11-b42d-00c04fc96400" },
  snoozes: 0,
  status: "active",
  missedReason: null,
  revision: 0,
  rhythm: "Einmalig",
});
const ALARMS = [
  alarm("6f9619ff-8b86-4d11-b42d-00c04fc96401", "Antwort von Lena Vogt prüfen"),
  alarm("6f9619ff-8b86-4d11-b42d-00c04fc96402", "Lieferavis von Spedition Brandt nachfassen"),
];

const until = async (check: () => boolean) => {
  for (let attempt = 0; attempt < 100 && !check(); attempt += 1) await new Promise((done) => setTimeout(done, 10));
  return check();
};

test("a click on the chip “Wecker · n” opens the list of the chat's alarms, and a second click closes it", async () => {
  const context = {
    chatId: () => "chat01",
    items: () => ALARMS,
    limit: () => 5,
    refresh: async () => undefined,
    locale: () => "de",
    timeZone: "Europe/Berlin",
  };
  cleanup.push(
    render(
      () => (
        <LocaleProvider locale="de">
          <AssistantWakeupDock context={context} layout="chip" />
        </LocaleProvider>
      ),
      dom.root,
    ),
  );
  const chip = dom.root.querySelector<HTMLButtonElement>("button.assistant-queue__chip")!;
  expect(chip.textContent?.replace(/\s+/g, " ").trim()).toBe("Wecker · 2");
  const list = () => dom.root.querySelector<HTMLElement>('[role="group"][aria-label="Wecker in diesem Chat"]');
  expect(list()).toBeNull();

  chip.click();
  expect(chip.getAttribute("aria-expanded")).toBe("true");
  expect(await until(() => list() !== null)).toBe(true);
  expect(list()?.id).toBe(chip.getAttribute("aria-controls") ?? "");
  expect(list()?.textContent).toContain("Antwort von Lena Vogt prüfen");
  expect(list()?.textContent).toContain("Lieferavis von Spedition Brandt nachfassen");

  chip.click();
  expect(chip.getAttribute("aria-expanded")).toBe("false");
  expect(list()).toBeNull();
});
