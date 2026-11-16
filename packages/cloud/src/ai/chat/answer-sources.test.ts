import { describe, expect, test } from "bun:test";
import { markdown } from "../../shared";
import type { AiTurnBlock } from "../protocol";
import { answerCitations, rootResourceLinks } from "./answer-links";
import { answerSources } from "./answer-source-model";

const md = (source: string) => markdown.renderSync(source, { locale: "de" });
const html = (source: string) => rootResourceLinks(markdown.renderSync(source, { locale: "de" }), (number) => `Quelle ${number}`);

describe("citations", () => {
  test("a link whose text is a number becomes a numbered chip that keeps its destination", () => {
    const rendered = html("Jana fragt zwei Dinge [1](/open/mail.thread/~messestand) und [2](https://example.com/preise).");
    expect(rendered).toContain('href="/open/mail.thread/~messestand"');
    expect(rendered).toContain('class="ai-cite" data-cite="1" aria-label="Quelle 1">1</a>');
    expect(rendered).toContain('href="https://example.com/preise"');
    expect(rendered).toContain('data-cite="2" aria-label="Quelle 2">2</a>');
    // The type icon of a reference and the arrow of a web link do not come along.
    expect(rendered).not.toContain("k2b-reference__icon");
    expect(rendered).not.toContain("k2b-text-link__external");
  });

  test("a titled link stays a reference and a three-digit number stays text", () => {
    const rendered = html("[Angebot](/open/files.file/~a) und [100](/open/files.file/~b)");
    expect(rendered).toContain('class="k2b-reference"');
    expect(rendered).not.toContain('data-cite="100"');
  });

  test("citations are read from the sanitized answer in number order, a number keeps its first destination", () => {
    expect(answerCitations(md("A [2](/open/b/~2), B [1](open/a/~1), C [2](/open/c/~3), D [1](/open/a/~1)"))).toEqual([
      { number: 1, href: "/open/a/~1" },
      { number: 2, href: "/open/b/~2" },
    ]);
    expect(answerCitations(md("[x](/open/a/~1) and `[1](/open/a/~2)` in code\n\n```\n[2](/open/a/~3)\n```"))).toEqual([]);
  });

  test("a destination keeps its parentheses and query, and a link the sanitizer drops is no source", () => {
    expect(answerCitations(md("[1](https://example.org/Topic_(detail)?a=1&b=2) [2](javascript:alert%281%29)"))).toEqual([
      { number: 1, href: "https://example.org/Topic_(detail)?a=1&b=2" },
    ]);
  });
});

const tool = (id: string, result: unknown, appId: string, appName: string, appIcon: string, appAccent?: string): AiTurnBlock => ({
  id,
  kind: "tool",
  callId: id,
  name: `${appId}__query__read`,
  status: "completed",
  result,
  presentation: { kind: "capability", appId, appName, appIcon, appAccent, title: "Lesen", capabilityKind: "query" },
});

describe("answer sources", () => {
  const blocks = [
    tool(
      "mail",
      { items: [{ href: "/open/mail.thread/~m", title: "Messestand Köln · Jana Berger" }] },
      "mail",
      "Mail",
      "ti ti-mail",
      "#1d4ed8",
    ),
    tool(
      "files",
      { ref: { type: "files.file", id: "a" }, href: "/open/files.file/~a", name: "Angebot.pdf" },
      "files",
      "Dateien",
      "ti ti-folder",
    ),
  ];

  test("a source takes its title and app from the result that names it", () => {
    expect(answerSources(md("x [1](/open/mail.thread/~m) y [2](/open/files.file/~a)"), blocks)).toEqual([
      { number: 1, href: "/open/mail.thread/~m", title: "Messestand Köln · Jana Berger", icon: "ti ti-mail", accent: "#1d4ed8" },
      { number: 2, href: "/open/files.file/~a", title: "Angebot.pdf", icon: "ti ti-folder", accent: undefined },
    ]);
  });

  test("a cited link no result names keeps its number with its app or host", () => {
    expect(answerSources(md("[1](/open/mail.thread/~other) [2](https://www.example.com/a) [3](/open/notes.page/~p)"), blocks)).toEqual([
      { number: 1, href: "/open/mail.thread/~other", title: "Mail", icon: "ti ti-mail", accent: "#1d4ed8" },
      { number: 2, href: "https://www.example.com/a", title: "example.com", icon: "ti ti-world", accent: undefined },
      { number: 3, href: "/open/notes.page/~p", title: "/open/notes.page/~p", icon: "ti ti-link", accent: undefined },
    ]);
  });

  test("a failed call names no source, and an answer without citations has none", () => {
    const failed = { ...blocks[0]!, status: "failed", isError: true } as AiTurnBlock;
    expect(answerSources(md("[1](/open/mail.thread/~m)"), [failed])[0]!.title).toBe("/open/mail.thread/~m");
    expect(answerSources(md("Kein Zitat."), blocks)).toEqual([]);
  });
});

/**
 * Kimi K3's answer in the Preview tour (15.11., chat "Was steht im Notebook …"), copied from the transcript: it writes
 * bare numbers in the text and adds its own sources paragraph at the end.
 */
const kimiAnswer = [
  "Im Notebook steht, wie der Wareneingang ablaufen soll: Lieferavise werden morgens geprüft und Paletten im Lager B gezählt [1].",
  "",
  "Auffällig: 14 der 22 Aufgaben heißen identisch „Lieferavise heute prüfen“ [2]. Das sieht nach einer Automatisierung aus.",
  "",
  "**Quellen:** [1] Notiz [Wareneingang](/open/notebooks.note/~wareneingang) im Notebook [Logistik-Handbuch](/open/notebooks.notebook/~handbuch) · [2] Aufgabenliste des Space [Logistik](/open/spaces.space/~logistik), abgerufen heute um 07:07 Uhr.",
].join("\n");

describe("a model that writes bare numbers and its own sources paragraph", () => {
  test("the numbers become chips to the destinations of its sources paragraph, which leaves the answer", () => {
    const rendered = html(kimiAnswer);
    expect(rendered).not.toContain("Quellen:");
    expect(rendered).not.toContain("abgerufen heute");
    expect(rendered).toMatch(
      /href="\/open\/notebooks\.note\/~wareneingang"[^>]* class="ai-cite" data-cite="1" aria-label="Quelle 1">1<\/a>/,
    );
    expect(rendered).toMatch(/href="\/open\/spaces\.space\/~logistik"[^>]* class="ai-cite" data-cite="2" aria-label="Quelle 2">2<\/a>/);
    expect(rendered).not.toContain("[1]");
    expect(rendered).not.toContain("[2]");
    // The row under the answer lists exactly the numbers in the text.
    expect(answerCitations(md(kimiAnswer))).toEqual([
      { number: 1, href: "/open/notebooks.note/~wareneingang" },
      { number: 2, href: "/open/spaces.space/~logistik" },
    ]);
  });

  test("a sources list with one numbered line per source leaves the answer as well", () => {
    const listed = "Zwei Dinge [1] und [2].\n\nQuellen:\n\n- [1] [Angebot](/open/files.file/~a)\n- [2](/open/mail.thread/~b) Mail von Jana";
    expect(answerCitations(md(listed))).toEqual([
      { number: 1, href: "/open/files.file/~a" },
      { number: 2, href: "/open/mail.thread/~b" },
    ]);
    expect(html(listed)).not.toContain("Quellen");
  });

  test("bare numbers without a destination, in code, and ordinary closing paragraphs stay text", () => {
    expect(html("Der Index ist [1] und `[2]`.")).toContain("[1]");
    expect(html("Der Index ist [1] und `[2]`.")).not.toContain("ai-cite");
    const closing = "Fertig [1](/open/a/~1).\n\nHinweis: Das gilt nur für Lager B.";
    expect(html(closing)).toContain("Hinweis:");
    expect(html("Siehe [1](/open/a/~1), nochmal [1] und im Code `[1]`.")).toContain(">[1]</code>");
  });
});
