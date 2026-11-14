import { describe, expect, test } from "bun:test";
import { markdown } from "../../shared";
import type { AiTurnBlock } from "../protocol";
import { answerCitations, rootResourceLinks } from "./answer-links";
import { answerSources } from "./answer-sources";

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

  test("citations are read from the source in number order, a number keeps its first destination", () => {
    expect(answerCitations("A [2](/open/b/~2), B [1](open/a/~1), C [2](/open/c/~3), D [1](/open/a/~1)")).toEqual([
      { number: 1, href: "/open/a/~1" },
      { number: 2, href: "/open/b/~2" },
    ]);
    expect(answerCitations("[x](/open/a/~1) and `[1]` without a link")).toEqual([]);
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
    expect(answerSources("x [1](/open/mail.thread/~m) y [2](/open/files.file/~a)", blocks)).toEqual([
      { number: 1, href: "/open/mail.thread/~m", title: "Messestand Köln · Jana Berger", icon: "ti ti-mail", accent: "#1d4ed8" },
      { number: 2, href: "/open/files.file/~a", title: "Angebot.pdf", icon: "ti ti-folder", accent: undefined },
    ]);
  });

  test("a cited link no result names keeps its number with its app or host", () => {
    expect(answerSources("[1](/open/mail.thread/~other) [2](https://www.example.com/a) [3](/open/notes.page/~p)", blocks)).toEqual([
      { number: 1, href: "/open/mail.thread/~other", title: "Mail", icon: "ti ti-mail", accent: "#1d4ed8" },
      { number: 2, href: "https://www.example.com/a", title: "example.com", icon: "ti ti-world", accent: undefined },
      { number: 3, href: "/open/notes.page/~p", title: "/open/notes.page/~p", icon: "ti ti-link", accent: undefined },
    ]);
  });

  test("a failed call names no source, and an answer without citations has none", () => {
    const failed = { ...blocks[0]!, status: "failed", isError: true } as AiTurnBlock;
    expect(answerSources("[1](/open/mail.thread/~m)", [failed])[0]!.title).toBe("/open/mail.thread/~m");
    expect(answerSources("Kein Zitat.", blocks)).toEqual([]);
  });
});
