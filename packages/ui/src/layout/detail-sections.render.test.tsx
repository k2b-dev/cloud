import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-detail-sections-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { DetailAccess, DetailLinks, DetailPresence, DetailProperties, DetailTags } = await import("./DetailSections");
const { LocaleProvider } = await import("../intl/locale");

const render = (element: () => JSX.Element, locale = "en") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return element();
      },
    }),
  );
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const people = [
  { id: "jana", name: "Jana Berger", shortName: "Jana", activity: "writing" as const, place: "Cold goods" },
  { id: "paul", name: "Paul Wagner", shortName: "Paul", activity: "reading" as const },
  { id: "me", name: "Anna Becker", self: true },
];

describe("DetailPresence", () => {
  test("live: counts the others, names who writes where, and keeps You apart", () => {
    const html = render(() => createComponent(DetailPresence, { people }));
    expect(html).toContain('data-state="live"');
    expect(text(html)).toContain("Here now 2");
    expect(text(html)).toContain("Jana in Cold goods · Paul is reading along");
    expect(html).toContain("k2b-detail-presence__self");
    expect(html.match(/data-live="true"/g)).toHaveLength(2);
  });
  test("alone reads Only you and the app's note", () => {
    const html = render(
      () => createComponent(DetailPresence, { people: [people[2]!], note: "Whoever opens the note appears here." }),
      "de",
    );
    expect(text(html)).toContain("Gerade hier Nur du");
    expect(text(html)).toContain("Whoever opens the note appears here.");
  });
  test("loading, offline, and unavailable keep the same two lines without live dots", () => {
    for (const state of ["loading", "offline", "unavailable"] as const) {
      const html = render(() => createComponent(DetailPresence, { people, state, note: "Note", onRetry: () => {} }));
      expect(html).toContain(`data-state="${state}"`);
      expect(html.match(/k2b-detail-presence__strip/g)).toHaveLength(1);
      expect(html.match(/k2b-detail-presence__where/g)).toHaveLength(1);
      expect(html).not.toContain('data-live="true"');
    }
    expect(text(render(() => createComponent(DetailPresence, { people, state: "unavailable", onRetry: () => {} })))).toContain(
      "Presence is unavailable right now Try again",
    );
  });
});

describe("DetailAccess", () => {
  const entries = ["Lager-Team", "Jana Berger", "Anna Becker", "Mira Schulz", "Paul Wagner", "Tom Krüger", "Lena Hoffmann"].map(
    (name, index) => ({ id: String(index), name, role: "Can edit", self: name === "Anna Becker" }),
  );
  test("closed it names the first entries; open it lists five and Show 2 more, read-only", () => {
    const html = render(() => createComponent(DetailAccess, { entries }));
    expect(text(html)).toContain("Access 7");
    expect(text(html)).toContain("Lager-Team, Jana Berger and 5 more");
    expect(html.match(/class="k2b-detail-panel__row[ "]/g)).toHaveLength(5);
    expect(text(html)).toContain("You");
    expect(text(html)).toContain("Show 2 more");
    expect(html).not.toMatch(/<(input|select)\b/);
  });
  test("manage appears only when passed; loading and error say so", () => {
    expect(text(render(() => createComponent(DetailAccess, { entries, manage: { label: "Manage access", href: "/settings" } })))).toContain(
      "Manage access",
    );
    expect(text(render(() => createComponent(DetailAccess, { entries: [], state: "loading" })))).toContain("Loading who has access");
    expect(text(render(() => createComponent(DetailAccess, { entries: [], state: "error", onRetry: () => {} })))).toContain(
      "Could not load who has access Try again",
    );
  });
});

describe("DetailLinks, DetailProperties, DetailTags", () => {
  test("links show both directions with their counts, or one row with None yet", () => {
    const html = render(() =>
      createComponent(DetailLinks, {
        incoming: [{ id: "a", title: "Onboarding", href: "/a" }],
        outgoing: [
          { id: "b", title: "Glossary", href: "/b" },
          { id: "c", title: "Places", href: "/c" },
        ],
      }),
    );
    expect(text(html)).toContain("Linked from 1");
    expect(text(html)).toContain("Links to 2");
    expect(text(render(() => createComponent(DetailLinks, { incoming: [], outgoing: [] })))).toBe("Links None yet");
  });
  test("properties are label and value rows; a value with href is a link", () => {
    const html = render(() =>
      createComponent(DetailProperties, {
        items: [
          { id: "words", label: "Length", value: "412 words" },
          { id: "history", label: "History", value: "23 versions", href: "/versions" },
        ],
        defaultOpen: true,
      }),
    );
    expect(html).toMatch(/<dt>Length<\/dt>/);
    expect(html).toContain('href="/versions"');
  });
  test("tags are chips or None yet with a hint", () => {
    expect(render(() => createComponent(DetailTags, { tags: [{ id: "x", label: "ramp", href: "/tags/ramp" }] }))).toContain(
      'href="/tags/ramp"',
    );
    expect(text(render(() => createComponent(DetailTags, { tags: [], emptyHint: "Add one with #name." })))).toBe(
      "Tags None yet Add one with #name.",
    );
  });
});
