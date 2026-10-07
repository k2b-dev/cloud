import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { AssistantChatContextSnapshot } from "../chat-context";
import { emptySidebarSnapshot, fileResult, minutesAgo, sidebarSnapshot } from "./AssistantChatSidebar.fixture";

const root = mkdtempSync(resolve(tmpdir(), "assistant-chat-sidebar-"));
const serovalLink = resolve(import.meta.dir, "../../node_modules/seroval");
const createdSerovalLink = !existsSync(serovalLink);
if (createdSerovalLink) symlinkSync(resolve(import.meta.dir, "../../../cloud/node_modules/seroval"), serovalLink, "dir");
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  if (createdSerovalLink) unlinkSync(serovalLink);
});

const { AssistantChatSidebarPanel } = await import("./AssistantChatSidebar");

const noop = () => undefined;
const actions = { onOpenFile: noop, onOpenApp: noop, onJump: noop, onOpenSecrets: noop };

export const renderSidebar = (snapshot: AssistantChatContextSnapshot | null, locale = "de") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(AssistantChatSidebarPanel, {
          id: "assistant-chat-context",
          state: { snapshot: () => snapshot, projectContext: () => null, error: () => undefined, refresh: async () => undefined },
          actions,
          onClose: noop,
        });
      },
    }),
  );

describe("Assistant chat sidebar, server render", () => {
  test("renders a labelled region with results first, cards with their description, and collapsed secondary sections", () => {
    const html = renderSidebar(sidebarSnapshot());
    expect(html).toContain('<aside id="assistant-chat-context"');
    expect(html).toContain('aria-labelledby="assistant-chat-context-title"');
    expect(html).toContain(">In diesem Chat</h2>");
    const order = ["Ergebnisse", "Umsatzbericht Q1-Q3.pdf", "Deine Dateien", "Quellen", "Arbeitsdateien", "Kontext"].map((label) =>
      html.indexOf(label),
    );
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain("Der fertige Bericht: Umsatz je Quartal");
    expect(html).toContain("Interaktives Dashboard zum Filtern");
    expect(html).toContain("Herunterladen");
    expect(html).toContain("Link kopieren");
    // The close control is static from the server on: it closes an open sidebar.
    expect(html).toMatch(
      /aria-label="Seitenleiste schließen"[^>]*aria-expanded="true"|aria-expanded="true"[^>]*aria-label="Seitenleiste schließen"/,
    );
    // Working files and sources stay one level deeper: their rows are closed and their contents not rendered.
    expect(html).toContain("2 Bilder");
    expect(html).not.toContain(">für Umsatzbericht Q1-Q3.pdf");
    expect(html).not.toContain("Umsatzstatistik im Handel");
    expect(html).toContain("1 Skill · 1 Erinnerung");
    expect(html).not.toContain("Umsätze immer netto");
  });

  test("keeps the results heading and explains the empty state in a chat without results", () => {
    const html = renderSidebar(emptySidebarSnapshot());
    expect(html).toContain("Ergebnisse");
    expect(html).toContain("Dateien, Apps und Visualisierungen, die der Assistant für dich erstellt, erscheinen hier.");
    expect(html).not.toContain("Deine Dateien");
    expect(html).not.toContain("Quellen");
    expect(html).toContain("Kontext");
  });

  test("groups older results by day and month from the snapshot's time, not the renderer's clock", () => {
    const snapshot = sidebarSnapshot({
      results: [
        fileResult("/neu.pdf", { at: minutesAgo(5), turn: "t9", seq: 90 }),
        fileResult("/gestern.pdf", { at: minutesAgo(60 * 26), turn: "t8", seq: 80 }),
        fileResult("/august.pdf", { at: "2026-08-14T10:00:00.000Z", turn: "t1", seq: 10 }),
      ],
    });
    const html = renderSidebar(snapshot);
    expect(html).toContain("Gestern");
    expect(html).toContain("August 2026");
    // A group row shows its count and its first titles; its entries render only when it opens.
    expect(html).toContain("gestern.pdf");
    expect(html).toContain('aria-expanded="false"');
  });

  test("never folds results of the latest turn into an older group; more than six fold into one row", () => {
    const results = Array.from({ length: 8 }, (_, index) =>
      fileResult(`/teil-${index + 1}.pdf`, { at: minutesAgo(10 + index), turn: "latest", seq: 40 }),
    );
    const html = renderSidebar(sidebarSnapshot({ results }));
    expect(html).toContain("3 weitere aus dieser Runde");
    for (const name of ["teil-1.pdf", "teil-5.pdf"]) expect(html).toContain(name);
    expect(html).not.toContain("teil-6.pdf");
  });

  test("shows the new-results control reserved and hidden when nothing waits", () => {
    const html = renderSidebar(sidebarSnapshot());
    expect(html).toContain("assistant-sidebar-new");
    expect(html).not.toContain('data-pending="true"');
  });

  test("renders English copy for an English reader", () => {
    const html = renderSidebar(sidebarSnapshot(), "en");
    expect(html).toContain(">In this chat</h2>");
    expect(html).toContain("Results");
    expect(html).toContain("Working files");
  });
});
