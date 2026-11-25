import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import { registerSsrTestPlugin } from "../../../../ui/test/ssr-test-plugin";

const root = mkdtempSync(resolve(tmpdir(), "faq-screens-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { FaqAdminFixture, FaqScreenFixture } = await import("./faq-screens.fixture");
const { describeV2 } = await import("@k2b/ui/v2");

const dom = createDomTestHarness();
dom.cleanup();
const parser = new dom.window.DOMParser();

/** The server HTML as a document, and the text a person reads in it. */
const parse = (html: string) => {
  const body = parser.parseFromString(html, "text/html").body;
  const workspace = body.firstElementChild;
  if (!workspace) throw new Error("The screen rendered nothing.");
  // Happy DOM's Element is the DOM Element at run time; only its TypeScript type is its own (as in describe.test.ts).
  const outline = describeV2(workspace as unknown as Element);
  for (const element of body.querySelectorAll("*")) element.after(" ");
  return { body, outline, text: body.textContent?.replace(/\s+/g, " ") ?? "" };
};

describe("the FAQ to read, on the server", () => {
  test("every question stands with its answer as Markdown, in the reader's language", () => {
    const { text, body, outline } = parse(renderToString(() => createComponent(FaqScreenFixture, { locale: "de" })));
    expect(text).toContain("Wie setze ich mein Passwort zurück?");
    // the entry without German falls back to English, as the service resolves it
    expect(text).toContain("Where do I find the opening hours?");
    expect(body.querySelector("strong")?.textContent).toBe("Profil › Sicherheit");
    expect(body.querySelector('a[href="https://example.org/contact"]')).not.toBeNull();
    expect(outline).not.toContain("Problems (");
  });

  test("no entry says so where the questions would stand", () => {
    const { text } = parse(renderToString(() => createComponent(FaqScreenFixture, { locale: "en", empty: true })));
    expect(text).toContain("No FAQ entries are available.");
  });

  test("the worst case keeps every part in place", () => {
    const { outline, text } = parse(renderToString(() => createComponent(FaqScreenFixture, { worst: true })));
    expect(text).toContain("日本語の質問はどこに表示されますか？");
    expect(outline).not.toContain("Problems (");
  });
});

describe("the FAQ administration, on the server", () => {
  test("the list names each entry's audiences and languages; nothing is open without an address", () => {
    const { text, outline } = parse(renderToString(() => createComponent(FaqAdminFixture, { locale: "de" })));
    expect(text).toContain("3 Einträge");
    expect(text).toContain("sichtbar unter /faq");
    expect(text).toContain("Gastprofile · Vollprofile");
    expect(text).toContain("Kein Eintrag geöffnet");
    expect(outline).toContain('primary "Neuer Eintrag"');
    expect(outline).not.toContain("Problems (");
  });

  test("an entry in the address opens its form beside the list with both languages and its audiences", () => {
    const { body, outline } = parse(
      renderToString(() => createComponent(FaqAdminFixture, { locale: "de", search: "entry=0b6c3c1e-1f7a-4d55-9a1e-2f0a9d7e1002" })),
    );
    expect(outline).toContain('Row "Wer sieht ein geteiltes Adressbuch?" / "Vollprofile" (EN DE) [current]');
    expect(outline).toContain('Field "Frage (Englisch)": Input "Who can see a shared address book?"');
    expect(outline).toContain('Field "Frage (Deutsch)": Input "Wer sieht ein geteiltes Adressbuch?"');
    expect(outline).toContain('Check "Vollprofile" on');
    expect(outline).toContain('Check "Gastprofile" off');
    expect(outline).toContain('["Speichern"]');
    expect(body.querySelector('a[href="/admin/faq"]')).not.toBeNull();
    expect(outline).not.toContain("Problems (");
  });

  test("a new entry starts empty for guests and full profiles; an unknown entry says it is gone", () => {
    const created = parse(renderToString(() => createComponent(FaqAdminFixture, { locale: "en", search: "entry=new" })));
    expect(created.outline).toContain('Bar: "New FAQ entry" lead');
    expect(created.outline).toContain('Check "Guest profiles" on');
    expect(created.outline).toContain('Check "Public (not signed in)" off');
    expect(created.outline).toContain('["Create entry"]');
    const missing = parse(
      renderToString(() => createComponent(FaqAdminFixture, { locale: "en", search: "entry=0b6c3c1e-1f7a-4d55-9a1e-2f0a9d7e9999" })),
    );
    expect(missing.text).toContain("This FAQ entry no longer exists.");
  });

  test("no entries yet offers the first one; the worst case keeps every part in place", () => {
    const empty = parse(renderToString(() => createComponent(FaqAdminFixture, { locale: "de", empty: true })));
    expect(empty.text).toContain("Noch keine FAQ-Einträge.");
    const worst = parse(
      renderToString(() => createComponent(FaqAdminFixture, { worst: true, search: "entry=0b6c3c1e-1f7a-4d55-9a1e-2f0a9d7e2001" })),
    );
    expect(worst.text).toContain("43 Einträge");
    expect(worst.outline).not.toContain("Problems (");
  });
});
