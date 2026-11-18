import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { AssistantQueueEntry, AssistantQueueProps } from "./AssistantQueue";

const root = mkdtempSync(resolve(tmpdir(), "assistant-queue-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
afterAll(() => rmSync(root, { recursive: true, force: true }));

const [{ default: AssistantQueue }, { LocaleProvider }] = await Promise.all([import("./AssistantQueue"), import("@k2b/ui")]);

const ENTRIES: AssistantQueueEntry[] = [
  {
    id: "q1",
    text: "Und markiere die Buchungen über 300 €",
    origin: { kind: "person", id: "u1", name: "Lena Vogt" },
    state: "pending",
    authorIsViewer: true,
  },
  {
    id: "q2",
    text: "Briefing für Montag",
    origin: { kind: "automation", id: "a1", name: "Morgen-Briefing" },
    state: "pending",
    authorIsViewer: false,
  },
  {
    id: "q3",
    text: "Bitte prüfe die Anzahlung",
    origin: { kind: "chat", id: "c1", name: "Messe Köln" },
    state: "pending",
    authorIsViewer: false,
  },
];

const html = (props: Partial<AssistantQueueProps> = {}, locale = "de") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(AssistantQueue, {
          entries: ENTRIES,
          layout: "line",
          sendingId: null,
          failedIds: new Set<string>(),
          busy: false,
          onSendNow: () => undefined,
          onEdit: () => undefined,
          onRemove: () => undefined,
          ...props,
        });
      },
    }),
  );
/** The action places of each row, in order: a button's name, the ring, or the empty place. */
const places = (markup: string) =>
  markup
    .split('class="assistant-queue__row ')
    .slice(1)
    .map((row) =>
      [...row.matchAll(/<button[^>]*aria-label="([^"]+)"|role="status" aria-label="[^"]+"|class="assistant-queue__slot"/g)].map((match) =>
        match[1] ? match[1] : match[0].startsWith("role") ? "ring" : "slot",
      ),
    );
/** Text on screen: without tags and without the tooltips, which are closed popovers until a pointer or focus opens them. */
const visibleText = (markup: string) => markup.replace(/<span[^>]*role="tooltip"[^>]*>[^<]*<\/span>/g, "").replace(/<[^>]+>/g, " ");

describe("queued messages", () => {
  test("rows keep the order of arrival with three sign buttons in fixed places", () => {
    const markup = html();
    expect([...markup.matchAll(/data-entry="([^"]+)"/g)].map((match) => match[1])).toEqual(["q1", "q2", "q3"]);
    expect(places(markup)).toEqual([
      ["Bearbeiten", "Jetzt senden", "Entfernen"],
      ["slot", "Jetzt senden", "Entfernen"],
      ["slot", "Jetzt senden", "Entfernen"],
    ]);
  });

  test("buttons are named by aria-label only; no visible Send now in either language", () => {
    for (const [locale, word] of [
      ["de", "Jetzt senden"],
      ["en", "Send now"],
    ] as const) {
      const markup = html({}, locale);
      expect(markup).toContain(`aria-label="${word}"`);
      expect(visibleText(markup)).not.toContain(word);
    }
  });

  test("the row previews the next entry with its source; the list names each source right behind the text", () => {
    const markup = html({ entries: [ENTRIES[1]!, ENTRIES[2]!] });
    expect(markup).toContain('class="assistant-queue__head"');
    expect(visibleText(markup)).toContain("Automation „Morgen-Briefing“");
    expect(visibleText(markup)).toContain("Chat „Messe Köln“");
    expect(markup).toMatch(
      /class="assistant-queue__text" title="Briefing für Montag">Briefing für Montag<\/span><span class="assistant-queue__origin">/,
    );
  });

  test("sending shows a ring for status and disables all other buttons; a failed entry reads Not sent and Send again", () => {
    const sending = html({ sendingId: "q2" });
    expect(places(sending)[1]).toEqual(["slot", "ring", "Entfernen"]);
    expect(
      [...sending.matchAll(/<button[^>]*class="[^"]*k2b-icon-button[^"]*"[^>]*>/g)].every((match) => match[0].includes("disabled")),
    ).toBe(true);
    const failed = html({ failedIds: new Set(["q1"]) });
    expect(places(failed)[0]).toEqual(["Bearbeiten", "Erneut senden", "Entfernen"]);
    expect(visibleText(failed)).toContain("Nicht gesendet");
  });

  test("beside Waiting for you the queue is the chip Queued · n", () => {
    const markup = html({ layout: "chip" });
    expect(markup).not.toContain('class="assistant-queue__head"');
    expect(visibleText(markup).replace(/\s+/g, " ")).toContain("Vorgemerkt · 3");
  });
});
