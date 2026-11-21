import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import type { AssistantChatContextGroup, AssistantChatContextSnapshot } from "../chat-context";
import { emptySidebarSnapshot, fileResult, minutesAgo, sidebarSnapshot } from "./AssistantChatSidebar.fixture";

const root = mkdtempSync(resolve(tmpdir(), "assistant-context-box-"));
const serovalLink = resolve(import.meta.dir, "../../node_modules/seroval");
const createdSerovalLink = !existsSync(serovalLink);
if (createdSerovalLink) symlinkSync(resolve(import.meta.dir, "../../../cloud/node_modules/seroval"), serovalLink, "dir");
registerSsrTestPlugin({ dev: true, rootDir: root });

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  if (createdSerovalLink) unlinkSync(serovalLink);
});

const { AssistantChatContextBox } = await import("./AssistantChatContextBox");

const noop = () => undefined;
const actions = { onOpen: noop, onJump: noop, onOpenAll: noop, onOpenSources: noop, onOpenContext: noop };

const renderBox = (snapshot: AssistantChatContextSnapshot | null, options: { locale?: string; error?: Error } = {}) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale: options.locale ?? "de",
      get children() {
        return createComponent(AssistantChatContextBox, {
          variant: "column",
          headingId: "assistant-chat-context-title",
          state: { snapshot: () => snapshot, projectContext: () => null, error: () => options.error, refresh: async () => undefined },
          actions,
          frozen: () => false,
        });
      },
    }),
  );

const automations: AssistantChatContextGroup = {
  key: "automations",
  label: "Automationen",
  count: 4,
  rows: [
    {
      key: "a1",
      icon: "ti ti-code",
      title: "Code von info@",
      word: "Bereit, noch aus",
      tone: "ai",
      attention: true,
      jump: { messageSeq: 9, callId: "c1" },
    },
    { key: "a2", icon: "ti ti-code", title: "Angebote nachfassen", word: "Eingeschaltet", tone: "ok" },
    { key: "a3", icon: "ti ti-code", title: "Wochenbericht Vertrieb", word: "Pausiert", tone: "warn" },
    { key: "a4", icon: "ti ti-code", title: "Lieferavise", word: "Abgelehnt", tone: "danger" },
  ],
};

describe('Box "In this chat", server render', () => {
  test("a labelled column: head with a reserved place for news and Open as tab, results, then sources and context", () => {
    const html = renderBox(sidebarSnapshot());
    expect(html).toContain('data-variant="column"');
    expect(html).toContain('aria-labelledby="assistant-chat-context-title"');
    expect(html).toMatch(/<h2 id="assistant-chat-context-title"[^>]*>In diesem Chat<\/h2>/);
    expect(html).toContain('aria-label="Als Tab öffnen"');
    // The place for "New · n" is rendered from the start, hidden while nothing waits.
    expect(html).toContain("assistant-context-box__new");
    expect(html).not.toContain('data-pending="true"');
    const order = [
      ">Ergebnisse<",
      "Umsatzbericht Q1-Q3.pdf",
      "Umsatz-Dashboard",
      "bestellungen-verknuepft.csv",
      ">Quellen<",
      ">Kontext<",
    ].map((label) => html.indexOf(label));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // No descriptions and no button rows: a row is a sign, a title, and one word or number at its end.
    expect(html).not.toMatch(/>Der fertige Bericht/);
    expect(html).not.toContain("Link kopieren");
    expect(html).toContain(">1,3 MB<");
    expect(html).toContain("1 Webseite, 1 Suche");
    expect(html).toContain("1 Skill, 1 Erinnerung");
    // Three results: no "Show all".
    expect(html).not.toContain("Alle anzeigen");
  });

  test("shows the three newest results and leads to all of them", () => {
    const results = Array.from({ length: 5 }, (_, index) =>
      fileResult(`/teil-${index + 1}.pdf`, { at: minutesAgo(10 + index), turn: `t${index}`, seq: 40 - index }),
    );
    const html = renderBox(sidebarSnapshot({ results }));
    for (const name of ["teil-1.pdf", "teil-2.pdf", "teil-3.pdf"]) expect(html).toContain(name);
    expect(html).not.toContain("teil-4.pdf");
    expect(html).toContain(">Alle anzeigen<");
    expect(html).toMatch(/assistant-context-box__count[^>]*>5</);
  });

  test("a further group from the snapshot draws like the results, with state words, a ring, and at most three rows", () => {
    const html = renderBox(sidebarSnapshot({ groups: [automations] }));
    expect(html).toContain(">Automationen<");
    expect(html).toContain("Bereit, noch aus");
    expect(html).toMatch(/data-attention=""/);
    expect(html).toContain('data-tone="ok"');
    expect(html).not.toContain("Lieferavise");
    expect(html.match(/>Alle anzeigen</g)?.length).toBe(1);
  });

  test("the chat's alarms: plain plum signs, the three next with their time, the rest unfolds in place", () => {
    const wakeups: AssistantChatContextGroup = {
      key: "wakeups",
      label: "Wecker",
      count: 5,
      unfold: true,
      rows: ["Antwort prüfen", "Posteingang zusammenfassen", "Lieferavis nachfassen", "Wochenplan vorlesen", "Rückruf vorbereiten"].map(
        (title, index) => ({ key: `wakeup:w${index}`, icon: "ti ti-alarm", title, word: `1${index}:00`, wakeup: `w${index}` }),
      ),
    };
    const html = renderBox(sidebarSnapshot({ groups: [wakeups] }));
    expect(html).toContain(">Wecker<");
    expect(html).toContain("Lieferavis nachfassen");
    expect(html).not.toContain("Wochenplan vorlesen");
    expect(html).toContain(">2 weitere anzeigen<");
    expect(html).not.toContain(">Alle anzeigen<");
    expect(html).toMatch(/data-row="wakeup:w0"[\s\S]*?class="assistant-context-box__icon ti ti-alarm"/);
    expect(renderBox(sidebarSnapshot({ groups: [{ ...wakeups, count: 2, rows: wakeups.rows.slice(0, 2) }] }))).not.toContain(
      "weitere anzeigen",
    );
  });

  test("never draws more than ten rows", () => {
    const results = Array.from({ length: 8 }, (_, index) => fileResult(`/r${index}.pdf`, { at: minutesAgo(index + 1), turn: "t", seq: 1 }));
    const groups = ["g1", "g2", "g3"].map((key) => ({ ...automations, key, label: key }));
    const html = renderBox(sidebarSnapshot({ results, groups }));
    expect(html.match(/class="assistant-context-box__row"/g)?.length ?? 0).toBeLessThanOrEqual(10);
  });

  test("says what will appear in a chat with nothing yet, shows rows of placeholders while loading, and retries an error", () => {
    expect(renderBox(emptySidebarSnapshot())).toContain("Ergebnisse, Quellen und Automationen dieses Chats erscheinen hier.");
    const loading = renderBox(null);
    expect(loading).toContain('role="status"');
    expect(loading.match(/k2b-skeleton/g)?.length).toBe(3);
    const failed = renderBox(null, { error: new Error("offline") });
    expect(failed).toContain("„In diesem Chat“ konnte nicht geladen werden.");
    expect(failed).toContain("Der Chat selbst ist davon nicht betroffen.");
    expect(failed).toContain(">Erneut versuchen<");
  });

  test("renders English copy for an English reader", () => {
    const html = renderBox(sidebarSnapshot(), { locale: "en" });
    expect(html).toContain(">In this chat</h2>");
    expect(html).toContain(">Results<");
    expect(html).toContain("1 web page, 1 search");
    expect(html).toContain('aria-label="Open as tab"');
  });
});
