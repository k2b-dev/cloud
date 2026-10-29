import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { delegateEvents, render } from "solid-js/web";
import type { z } from "zod";
import { createDomTestHarness, type DomTestHarness } from "../../../ui/test/dom";
import type { NotificationsSchema, NotificationUpdateSchema } from "../service/contracts";

type Notifications = z.infer<typeof NotificationsSchema>;
type Update = z.infer<typeof NotificationUpdateSchema>;

let dom: DomTestHarness;
beforeEach(() => {
  dom = createDomTestHarness();
  // Each test has its own document; Solid's delegated handlers are registered per document.
  delegateEvents(["click", "keydown"], dom.document);
});
afterEach(() => dom.cleanup());

const flush = async () => {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
};

const mount = async (initial: Notifications, save: (input: Update) => Promise<Notifications>, locale = "de") => {
  const { LocaleProvider } = await import("@k2b/ui");
  const { default: ChatNotificationSettings } = await import("./ChatNotificationSettings");
  const [notifications, setNotifications] = createSignal(initial);
  const dispose = render(
    () =>
      createComponent(LocaleProvider, {
        locale,
        get children() {
          return createComponent(ChatNotificationSettings, {
            conversation: { kind: "chat", channel: false },
            get notifications() {
              return notifications();
            },
            dateConfig: { locale, timeZone: "UTC" },
            now: () => new Date("2026-10-28T10:42:00Z"),
            save: async (input) => setNotifications(await save(input)),
          });
        },
      }),
    dom.root,
  );
  const radio = (name: string) =>
    [...dom.root.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((element) => element.textContent?.startsWith(name))!;
  return { dispose, radio };
};
const base: Notifications = { level: "all", choice: null, until: null, defaultLevel: "all", following: null };

test("a choice saves at once, Off sends its duration, and the default gives the choice back to the chat", async () => {
  const saved: Update[] = [];
  const { dispose, radio } = await mount(base, async (input) => {
    saved.push(input);
    return input.level === "none"
      ? { ...base, level: "none", choice: "none", until: input.for === "forever" ? null : "2026-10-28T18:42:00Z" }
      : input.level === "default"
        ? base
        : { ...base, level: input.level, choice: input.level };
  });
  try {
    radio("Nur Erwähnungen").click();
    await flush();
    radio("Aus").click();
    await flush();
    expect(dom.root.textContent).toContain("Aus bis heute 18:42. Danach gilt wieder „Alle Nachrichten“.");
    [...dom.root.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((chip) => chip.textContent === "Bis ich es ändere")!.click();
    await flush();
    expect(dom.root.textContent).toContain("Bleibt aus, bis du es änderst.");
    radio("Alle Nachrichten").click();
    await flush();
    expect(saved).toEqual([{ level: "mentions" }, { level: "none", for: "8h" }, { level: "none", for: "forever" }, { level: "default" }]);
    expect(radio("Alle Nachrichten").getAttribute("aria-checked")).toBe("true");
  } finally {
    dispose();
  }
});

test("a failed save returns to the saved level, says what applies, and retries the same choice", async () => {
  let fail = true;
  const save = mock(async (input: Update) => {
    if (fail) throw new Error("offline");
    return { ...base, level: input.level === "none" ? "none" : "mentions", choice: "mentions" } satisfies Notifications;
  });
  const { dispose, radio } = await mount(base, save);
  try {
    const status = dom.root.querySelector(".chat-notifications__status")!;
    radio("Nur Erwähnungen").click();
    await flush();
    expect(radio("Alle Nachrichten").getAttribute("aria-checked")).toBe("true");
    expect(status.querySelector('[role="alert"]')?.textContent).toContain("Nicht gespeichert. Es gilt weiter „Alle Nachrichten“.");
    // The message took the reserved place: the status element is the same one.
    expect(dom.root.querySelector(".chat-notifications__status")).toBe(status);
    fail = false;
    [...status.querySelectorAll("button")].find((button) => button.textContent === "Erneut versuchen")!.click();
    await flush();
    expect(save.mock.calls.map(([input]) => input)).toEqual([{ level: "mentions" }, { level: "mentions" }]);
    expect(status.querySelector('[role="alert"]')).toBeNull();
    expect(radio("Nur Erwähnungen").getAttribute("aria-checked")).toBe("true");
  } finally {
    dispose();
  }
});

test("a failed duration change returns the chips to the duration that still applies", async () => {
  const muted: Notifications = { ...base, level: "none", choice: "none", until: null };
  const { dispose } = await mount(muted, async () => {
    throw new Error("offline");
  });
  try {
    const chip = (label: string) =>
      [...dom.root.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((element) => element.textContent === label)!;
    expect(chip("Bis ich es ändere").getAttribute("aria-checked")).toBe("true");
    chip("1 Stunde").click();
    await flush();
    expect(chip("Bis ich es ändere").getAttribute("aria-checked")).toBe("true");
    expect(chip("1 Stunde").getAttribute("aria-checked")).toBe("false");
    expect(dom.root.textContent).toContain("Nicht gespeichert. Es gilt weiter „Aus“.");
    expect(dom.root.textContent).toContain("Bleibt aus, bis du es änderst.");
  } finally {
    dispose();
  }
});
