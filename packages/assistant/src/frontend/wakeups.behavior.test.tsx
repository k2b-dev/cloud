import { afterAll, afterEach, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import type { AiWakeup } from "@k2b/cloud/ai";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

const bootstrap = createDomTestHarness();
const { LocaleProvider } = await import("@k2b/ui");
const { WakeupDialog } = await import("./wakeups");
bootstrap.cleanup();

// Monday, 16 November 2026, 10:00 in Berlin.
beforeAll(() => setSystemTime(new Date("2026-11-16T09:00:00.000Z")));
afterAll(() => setSystemTime());
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const stop of cleanup.splice(0).reverse()) stop();
});

const alarm: AiWakeup = {
  id: "6f9619ff-8b86-4d11-b42d-00c04fc964ff",
  at: "2026-11-16T15:00:00.000Z",
  cron: null,
  timezone: "Europe/Berlin",
  endsAt: null,
  note: "Antwort von Lena Vogt prüfen",
  noteSource: { kind: "person", userId: "6f9619ff-8b86-4d11-b42d-00c04fc96400" },
  snoozes: 0,
  status: "active",
  missedReason: null,
  revision: 3,
  rhythm: "Einmalig",
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 5; i++) await flush();
};

test("a change made meanwhile: the dialog says so once, Reload reads the alarm again, the entries stay, and saving uses the new revision", async () => {
  const dom = createDomTestHarness();
  cleanup.push(dom.cleanup);
  const [items, setItems] = createSignal<readonly AiWakeup[]>([alarm]);
  let refreshed = 0;
  const sent: { revision: number; note?: string }[] = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        sent.push(JSON.parse(String(init?.body)));
        return sent.length === 1
          ? Response.json(
              { code: "wakeup_conflict", message: "Der Wecker wurde geändert. Öffne die Liste vor dem Speichern erneut." },
              { status: 409 },
            )
          : Response.json({ ...alarm, revision: 5 });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  cleanup.push(() => fetchSpy.mockRestore());
  let closed = 0;
  const ctx = {
    chatId: () => "chat01",
    items,
    limit: () => 5,
    refresh: async () => {
      refreshed += 1;
      // Gustav postponed it meanwhile: the list now has a newer revision and time.
      setItems([{ ...alarm, at: "2026-11-16T16:00:00.000Z", revision: 4 }]);
    },
    locale: () => "de",
    timeZone: "Europe/Berlin",
  };
  cleanup.push(
    render(
      () => (
        <LocaleProvider locale="de">
          <WakeupDialog ctx={ctx} wakeup={alarm} close={() => closed++} guard={() => undefined} />
        </LocaleProvider>
      ),
      dom.root,
    ),
  );
  const note = dom.root.querySelector<HTMLTextAreaElement>("textarea")!;
  note.value = "Antwort von Lena Vogt und Tom prüfen";
  note.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
  dom.root.querySelector<HTMLFormElement>("form")!.requestSubmit();
  await settle();

  const text = () => dom.root.textContent ?? "";
  expect(text()).toContain("Nicht gespeichert: Der Wecker wurde inzwischen geändert und bleibt bei heute 16:00.");
  const alert = dom.root.querySelector('[role="alert"]')?.textContent ?? "";
  expect(alert.match(/Wecker/g)?.length).toBe(1);
  const primary = () => Array.from(dom.root.querySelectorAll<HTMLButtonElement>("footer button")).at(-1)!;
  expect(primary().textContent).toContain("Neu laden");
  expect(primary().type).toBe("button");

  primary().click();
  await settle();
  expect(refreshed).toBe(1);
  expect(note.value).toBe("Antwort von Lena Vogt und Tom prüfen");
  expect(primary().textContent).toContain("Speichern");

  dom.root.querySelector<HTMLFormElement>("form")!.requestSubmit();
  await settle();
  expect(sent.map((body) => body.revision)).toEqual([3, 4]);
  expect(sent[1]?.note).toBe("Antwort von Lena Vogt und Tom prüfen");
  expect(closed).toBe(1);
});
