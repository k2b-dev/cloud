import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import { registerSsrTestPlugin } from "../../../../../ui/test/ssr-test-plugin";

// Skills and Projects as the server renders them: the first picture holds the rows, the source app and its state, the
// problems in their colour, and no loading placeholder.
const root = mkdtempSync(resolve(tmpdir(), "core-ai-content-render-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { LocaleProvider } = await import("@k2b/ui");
const { adminNavFixture } = await import("../admin-v2.fixture");
const { default: SkillsScreen } = await import("./SkillsScreen");
const { default: ProjectsScreen } = await import("./ProjectsScreen");
const { skillsFixture, projectsFixture } = await import("./fixture-content");

const dom = createDomTestHarness();
dom.cleanup();
const parser = new dom.window.DOMParser();
const render = (locale: string, screen: () => JSX.Element) => {
  const html = renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return screen();
      },
    }),
  );
  const body = parser.parseFromString(html, "text/html").body;
  for (const element of body.querySelectorAll("*")) element.after(" ");
  return { body, text: body.textContent?.replace(/\s+/g, " ") ?? "" };
};
const input = (locale: "de" | "en", query = "", state = "normal") => ({ state, params: new URLSearchParams(query), locale });
const nav = adminNavFixture("/admin/ai");
const loaders = (body: { querySelectorAll(selector: string): { length: number } }) =>
  body.querySelectorAll('[data-k2-part="Loading"], [aria-busy="true"]').length;

describe("Skills on the server", () => {
  test("the list names the app and state of an app's Skill; a Skill without admin is the one problem in colour", () => {
    const { body, text } = render("en", () => createComponent(SkillsScreen, { nav, data: skillsFixture(input("en")) }));
    for (const words of [
      "14 shared Skills",
      "Grids",
      "Kontakte",
      "Mail · Customized",
      "App update available",
      "Wetter · App not available",
      "Managed by app",
      "2 Skills without an admin",
      "App Skills not installed",
      "Deleted",
      "Name in use",
      "Invalid content",
    ])
      expect(text).toContain(words);
    expect(body.querySelectorAll('[data-k2-part="Notice"][data-tone="bad"]').length).toBe(1);
    // a Skill of its own needs no source word in every row; the open Skill names it
    expect(text).not.toMatch(/Custom(?!ized)/);
    // deeds of app Skills that can come back; the invalid one has none
    expect(body.querySelector('[aria-label="Actions for app Skill cloud-spaces"]')).not.toBeNull();
    expect(body.querySelector('[aria-label="Actions for app Skill mail-signature"]')).toBeNull();
    expect(loaders(body)).toBe(0);
  });

  test("an open Skill stands beside the list with its facts and deeds; German words come from the inherited locale", () => {
    const { body, text } = render("de", () =>
      createComponent(SkillsScreen, { nav, data: skillsFixture(input("de", "sec=skills&skill=sk0004")) }),
    );
    for (const words of ["cloud-contacts", "Berechtigungen", "Update der App verfügbar", "Von App Kontakte", "Referenzdateien", "sk0004"])
      expect(text).toContain(words);
    expect(loaders(body)).toBe(0);
  });

  test("a search without matches says so and leads back to all Skills", () => {
    const { text, body } = render("en", () =>
      createComponent(SkillsScreen, { nav, data: skillsFixture(input("en", "sec=skills&search=zzz")) }),
    );
    expect(text).toContain("No Skills match “zzz”.");
    expect(body.querySelector('a[href="/admin/ai?sec=skills"]')).not.toBeNull();
  });
});

describe("Projects on the server", () => {
  test("the list shows each Project with its own symbol; Projects without admin are the problem", () => {
    const { body, text } = render("en", () => createComponent(ProjectsScreen, { nav, data: projectsFixture(input("en")) }));
    for (const words of ["10 shared Projects", "Website-Relaunch", "2 Projects without an admin", "No admins"])
      expect(text).toContain(words);
    expect(loaders(body)).toBe(0);
  });

  test("a long list leads to its next page and keeps the search", () => {
    const { body, text } = render("en", () =>
      createComponent(ProjectsScreen, { nav, data: projectsFixture(input("en", "sec=projects&page=2", "worst")) }),
    );
    expect(text).toContain("page 2 of 124");
    expect(body.querySelector('a[href="/admin/ai?sec=projects&page=3"]')).not.toBeNull();
    expect(body.querySelector('a[href="/admin/ai?sec=projects"]')).not.toBeNull();
  });
});
