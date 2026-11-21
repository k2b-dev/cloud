import { expect, test } from "bun:test";
import "../../../ui/test/solid-ssr-preload";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { AssistantQueueEntry } from "./AssistantQueue";

const [{ default: AssistantQueue }, { LocaleProvider }] = await Promise.all([import("./AssistantQueue"), import("@k2b/ui")]);

// Fictitious queue: an automation's message waits behind the person's own (Automationen als Code v5, 4.5).
type Case = "pending" | "retrying" | "failed";
// Cloud reports a start it retries by itself as a failed entry with `dispatch_failed` and `retrying`.
const STATES: Record<Case, Pick<AssistantQueueEntry, "state" | "error" | "retrying">> = {
  pending: { state: "pending", error: null, retrying: false },
  retrying: { state: "failed", error: "dispatch_failed", retrying: true },
  failed: { state: "failed", error: null, retrying: false },
};
const entries = (state: Case): AssistantQueueEntry[] => [
  {
    id: "q1",
    text: "Mein Morgenbriefing: Termine, Angebote älter als eine Woche, unbeantwortete Kundenmails.",
    origin: { kind: "automation", id: "a1", name: "Morgenbriefing", href: "/app/assistant/code/a1" },
    authorIsViewer: false,
    ...STATES[state],
  },
];
const html = (state: Case, locale = "de") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(AssistantQueue, {
          entries: entries(state),
          layout: "line",
          sendingId: null,
          failedIds: new Set<string>(),
          busy: false,
          onSendNow: () => undefined,
          onEdit: () => undefined,
          onRemove: () => undefined,
        });
      },
    }),
  );
const text = (markup: string) => markup.replace(/<span[^>]*role="tooltip"[^>]*>[^<]*<\/span>/g, "").replace(/<[^>]+>/g, " ");
const rowButtons = (markup: string) =>
  [...(markup.split('class="assistant-queue__row ')[1] ?? "").matchAll(/<button[^>]*aria-label="([^"]+)"/g)].map((match) => match[1]);

test("an automation's entry names its source, can be sent now or removed, and is never edited", () => {
  const markup = html("pending");
  expect(text(markup)).toContain("Automation „Morgenbriefing“");
  expect(markup).toContain('data-kind="automation"');
  expect(rowButtons(markup)).toEqual(["Jetzt senden", "Entfernen"]);
  expect(markup).toContain('class="assistant-queue__slot"');
});

test("an entry Cloud could not start yet says that it tries again, apart from one that was not sent", () => {
  for (const [locale, word, sentence] of [
    ["de", "Neuer Versuch folgt", "Start fehlgeschlagen. Neuer Versuch folgt."],
    ["en", "Retrying soon", "Could not start. Retrying shortly."],
  ] as const) {
    const markup = html("retrying", locale);
    // One short word on the row; the whole sentence in the tooltip and for screen readers.
    expect(markup).toContain(`class="assistant-queue__state" data-state="retrying" title="${sentence}"><i class="ti ti-refresh"`);
    expect(markup).toContain(`<span aria-hidden="true">${word}</span><span class="k2b-sr-only">${sentence}</span>`);
    expect(text(markup)).toContain(word);
    expect(text(markup)).not.toContain(locale === "de" ? "Nicht gesendet" : "Not sent");
  }
  // The person may still send it now themselves; Cloud names that as sending again.
  expect(rowButtons(html("retrying"))).toEqual(["Erneut senden", "Entfernen"]);
  expect(text(html("failed"))).toContain("Nicht gesendet");
});

test("an automation Cloud could not name for this reader stands as Automation behind the text, never as its own name", () => {
  const unnamed: AssistantQueueEntry = {
    ...entries("pending")[0]!,
    origin: { kind: "automation", id: "c_brief1", name: "Automation", named: false },
  };
  const markup = renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return createComponent(AssistantQueue, {
          entries: [unnamed],
          layout: "line",
          sendingId: null,
          failedIds: new Set<string>(),
          busy: false,
          onSendNow: () => undefined,
          onEdit: () => undefined,
          onRemove: () => undefined,
        });
      },
    }),
  );
  expect(text(markup).replace(/\s+/g, " ")).toMatch(/· , Automation\b/);
  expect(text(markup)).not.toContain("„Automation“");
});
