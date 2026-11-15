import { afterEach, expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import type { AssistantQueueEntry, AssistantQueueProps } from "./AssistantQueue";

const bootstrap = createDomTestHarness();
const { LocaleProvider } = await import("@k2b/ui");
const { default: AssistantQueue } = await import("./AssistantQueue");
bootstrap.cleanup();

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const stop of cleanup.splice(0).reverse()) stop();
});

// Fictitious entries in the order the server received them: one's own, an automation, another chat, one's own again.
const ENTRIES: AssistantQueueEntry[] = [
  { id: "q1", text: "Und markiere die Buchungen über 300 €", origin: { kind: "person", id: "u1", name: "Lena Vogt" }, state: "pending", authorIsViewer: true },
  {
    id: "q2",
    text: "Briefing für Montag: 3 neue Lieferavise, 1 Mahnung fällig, 2 Termine am Vormittag und eine offene Rückfrage von Holzhandel Nord",
    origin: { kind: "automation", id: "a1", name: "Morgen-Briefing", href: "/app/code/a1" },
    state: "pending",
    authorIsViewer: false,
  },
  { id: "q3", text: "Bitte prüfe, ob die Anzahlung eingegangen ist", origin: { kind: "chat", id: "c1", name: "Messe Köln" }, state: "pending", authorIsViewer: false },
  { id: "q4", text: "Leg die Tabelle danach in den Space Buchhaltung", origin: { kind: "person", id: "u1", name: "Lena Vogt" }, state: "pending", authorIsViewer: true },
];

const mount = (overrides: Partial<AssistantQueueProps> = {}, locale = "de") => {
  const dom = createDomTestHarness();
  cleanup.push(dom.cleanup);
  const calls: string[] = [];
  const [entries, setEntries] = createSignal<readonly AssistantQueueEntry[]>(overrides.entries ?? ENTRIES);
  const [sendingId, setSendingId] = createSignal<string | null>(overrides.sendingId ?? null);
  const [failedIds, setFailedIds] = createSignal<ReadonlySet<string>>(overrides.failedIds ?? new Set());
  cleanup.push(
    render(
      () => (
        <LocaleProvider locale={locale}>
          <AssistantQueue
            layout={overrides.layout ?? "line"}
            entries={entries()}
            sendingId={sendingId()}
            failedIds={failedIds()}
            busy={overrides.busy ?? false}
            onSendNow={(entry) => calls.push(`send:${entry.id}`)}
            onEdit={(entry) => calls.push(`edit:${entry.id}`)}
            onRemove={(entry) => calls.push(`remove:${entry.id}`)}
          />
        </LocaleProvider>
      ),
      dom.root,
    ),
  );
  const rows = () => Array.from(dom.root.querySelectorAll<HTMLElement>(".assistant-queue__row"));
  const labels = (row: HTMLElement) =>
    Array.from(row.querySelectorAll<HTMLElement>(".assistant-queue__actions > *")).map((element) =>
      element.matches("button") ? element.getAttribute("aria-label") : element.getAttribute("role") === "status" ? "ring" : "slot",
    );
  const toggle = () => dom.root.querySelector<HTMLButtonElement>("[aria-controls]")!;
  return { dom, calls, rows, labels, toggle, setEntries, setSendingId, setFailedIds };
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("the list keeps the order of arrival and gives every entry its buttons in fixed places", () => {
  const { rows, labels, calls } = mount();
  expect(rows().map((row) => row.dataset.entry)).toEqual(["q1", "q2", "q3", "q4"]);
  // Edit only on one's own entries; elsewhere its place stays, empty and without a tab stop.
  expect(rows().map(labels)).toEqual([
    ["Bearbeiten", "Jetzt senden", "Entfernen"],
    ["slot", "Jetzt senden", "Entfernen"],
    ["slot", "Jetzt senden", "Entfernen"],
    ["Bearbeiten", "Jetzt senden", "Entfernen"],
  ]);
  expect(rows()[1]!.querySelector(".assistant-queue__slot")!.matches("button, [tabindex]")).toBe(false);
  // No reordering: nothing to drag, nothing to move up or down.
  expect(rows().some((row) => row.querySelector("[draggable], [aria-roledescription]"))).toBe(false);

  const [own, automation] = rows();
  own!.querySelector<HTMLButtonElement>('[aria-label="Bearbeiten"]')!.click();
  automation!.querySelector<HTMLButtonElement>('[aria-label="Jetzt senden"]')!.click();
  automation!.querySelector<HTMLButtonElement>('[aria-label="Entfernen"]')!.click();
  expect(calls).toEqual(["edit:q1", "send:q2", "remove:q2"]);
});

test("every button is named by aria-label and none shows a word such as Send now", () => {
  for (const locale of ["de", "en"]) {
    const { dom } = mount({}, locale);
    const buttons = Array.from(dom.root.querySelectorAll<HTMLButtonElement>(".assistant-queue__actions button"));
    expect(buttons.length).toBe(10);
    for (const button of buttons) {
      expect(button.getAttribute("aria-label")?.length).toBeGreaterThan(0);
      expect(button.textContent?.trim()).toBe("");
    }
    expect(dom.root.textContent).not.toContain(locale === "de" ? "Jetzt senden" : "Send now");
  }
});

test("the row above the field previews only the next entry and has no action of its own", () => {
  const { dom, toggle } = mount();
  const row = dom.root.querySelector<HTMLElement>(".assistant-queue")!;
  const outsideList = Array.from(row.querySelectorAll("button")).filter((button) => !button.closest(".assistant-queue__list"));
  expect(outsideList).toEqual([toggle()]);
  expect(row.querySelector(".assistant-queue__next")!.textContent).toBe("Und markiere die Buchungen über 300 €");
  expect(toggle().textContent).toContain("+3");
  expect(toggle().getAttribute("aria-label")).toBe("Alle 4 vorgemerkten Nachrichten zeigen");
});

test("text and source stand in one line: the text carries the full wording, the source sits right behind it", () => {
  const { rows } = mount();
  const automation = rows()[1]!;
  const text = automation.querySelector<HTMLElement>(".assistant-queue__text")!;
  expect(text.title).toBe(ENTRIES[1]!.text);
  expect(text.textContent).toBe(ENTRIES[1]!.text);
  expect(text.nextElementSibling!.matches(".assistant-queue__origin")).toBe(true);
  expect(automation.querySelector(".assistant-queue__origin")!.textContent).toContain("Automation „Morgen-Briefing“");
  expect(rows()[2]!.querySelector(".assistant-queue__origin")!.textContent).toContain("Chat „Messe Köln“");
  expect(rows()[0]!.querySelector(".assistant-queue__origin")).toBeNull();
});

test("the list opens on a press, closes with Escape and gives the focus back", () => {
  const { dom, toggle } = mount();
  const list = dom.root.querySelector<HTMLElement>(".assistant-queue__list")!;
  expect(list.hidden).toBe(true);
  toggle().click();
  expect(list.hidden).toBe(false);
  expect(toggle().getAttribute("aria-expanded")).toBe("true");
  list.querySelector<HTMLButtonElement>("button")!.focus();
  dom.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event);
  expect(list.hidden).toBe(true);
  expect(dom.document.activeElement).toBe(toggle());
});

test("Send now shows a ring in its place and locks every other button until Cloud answers", () => {
  const { rows, labels, setSendingId, dom } = mount();
  setSendingId("q2");
  const sending = rows()[1]!;
  expect(labels(sending)).toEqual(["slot", "ring", "Entfernen"]);
  expect(sending.querySelector('[role="status"]')!.getAttribute("aria-label")).toBe("Wird gesendet…");
  expect(sending.querySelector(".assistant-queue__actions")!.hasAttribute("data-pinned")).toBe(true);
  expect(Array.from(dom.root.querySelectorAll<HTMLButtonElement>(".assistant-queue__actions button")).every((button) => button.disabled)).toBe(
    true,
  );
});

test("an entry that was not sent says so in the list and in the row, and its send sign reads Send again", () => {
  const { rows, labels, setFailedIds, dom } = mount();
  setFailedIds(new Set(["q1"]));
  expect(labels(rows()[0]!)).toEqual(["Bearbeiten", "Erneut senden", "Entfernen"]);
  expect(rows()[0]!.querySelector(".assistant-queue__state")!.textContent).toBe("Nicht gesendet");
  expect(dom.root.querySelector(".assistant-queue__next + .assistant-queue__state")!.textContent).toBe("Nicht gesendet");
  // The server's own state reads the same.
  const second = mount({ entries: [{ ...ENTRIES[2]!, state: "failed" }] });
  expect(second.labels(second.rows()[0]!)).toEqual(["slot", "Erneut senden", "Entfernen"]);
});

test("a new entry is announced once, the first list is not", async () => {
  const { dom, setEntries } = mount({ entries: ENTRIES.slice(0, 2) });
  const live = dom.root.querySelector('[aria-live="polite"]')!;
  expect(live.textContent).toBe("");
  setEntries(ENTRIES.slice(0, 3));
  expect(live.textContent).toBe("Vorgemerkt: Bitte prüfe, ob die Anzahlung eingegangen ist");
  setEntries(ENTRIES.slice(1, 3));
  await flush();
  expect(live.textContent).toBe("Vorgemerkt: Bitte prüfe, ob die Anzahlung eingegangen ist");
});

test("beside Waiting for you the queue is one chip, Queued · n, that opens the same list", () => {
  const { dom, toggle } = mount({ layout: "chip" });
  expect(dom.root.querySelector(".assistant-queue__next")).toBeNull();
  expect(toggle().textContent?.replace(/\s+/g, " ").trim()).toBe("Vorgemerkt · 4");
  toggle().click();
  expect(dom.root.querySelector<HTMLElement>(".assistant-queue__list")!.hidden).toBe(false);
});
