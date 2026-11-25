import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../test/ssr-test-plugin";

// What the server sends for a primitive is what the browser shows on its first render: these cases differed (#4147,
// #4148). The v2 modules are Solid modules (`.tsx`), compiled by the registered plugin, so they are imported after it.
const root = mkdtempSync(resolve(tmpdir(), "k2-v2-server-markup-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { Bar, Pane, Workspace } = await import("./layout");
const { Nav, Tabs } = await import("./components");
const { Button } = await import("./button");
const { Input } = await import("./controls");
const { Text } = await import("./content");

const split = (more: JSX.Element) =>
  renderToString(() =>
    createComponent(Pane.Split, {
      get children() {
        return [createComponent(Pane, { label: "Liste", children: createComponent(Text, { children: "Eintrag" }) }), more];
      },
    }),
  );
const seams = (markup: string) => markup.match(/class="k2-seam"/g)?.length ?? 0;

test("a split draws no seam for a child that renders nothing, so `{open && <Pane …/>}` draws one line", () => {
  const alone = seams(split(undefined));
  expect(alone).toBe(1);
  for (const nothing of [false, true, null, ""]) expect(seams(split(nothing))).toBe(alone);
});

// HTML drops one newline at the start of a textarea's text: the server sends one more, so leading blank lines stay.
test("a multi-line field sends its value as the text of its textarea, leading blank lines too", () => {
  for (const value of ["Zwei <Zeilen>\nund mehr", "\nErste\nZweite", "\n\nNach zwei Leerzeilen", ""]) {
    const markup = renderToString(() => createComponent(Input, { multiline: true, label: "Notiz", value }));
    expect(markup).toContain(`>\n${value.replaceAll("<", "&lt;")}</textarea>`);
  }
  // no value: an empty textarea
  expect(renderToString(() => createComponent(Input, { multiline: true, label: "Notiz" }))).toContain(">\n</textarea>");
});

// The head names the page in the page's one heading (maintainer, 25.11.: a head with deeds on the right and nothing on
// the left looked as if something were missing; lane U found no h1 on v2 pages).
const page = (props: { title?: string; head?: () => JSX.Element; sidebar?: () => JSX.Element }) =>
  renderToString(() =>
    createComponent(Workspace, {
      title: props.title,
      get head() {
        return props.head?.();
      },
      get sidebar() {
        return props.sidebar?.();
      },
      get children() {
        return createComponent(Pane, { label: "Liste", children: "Eintrag" });
      },
    }),
  );
const deeds = () =>
  createComponent(Bar, {
    get end() {
      return createComponent(Button, { children: "Neu" });
    },
  });
const headings = (markup: string) =>
  [...markup.matchAll(/<h1[^>]*class="([^"]+)"[^>]*>([^<]*)<\/h1>/g)].map((found) => `${found[1]}: ${found[2]}`);

test("the head names the page in its one h1: the title, else the Nav's current entry, beside tabs only to be heard", () => {
  expect(headings(page({ title: "Notizbücher", head: deeds }))).toEqual(["k2-head-title: Notizbücher"]);
  const nav = () =>
    createComponent(Nav, {
      title: "Notizbücher",
      icon: "notebook",
      groups: [
        {
          items: [
            { label: "Team Logistik", icon: "flag" },
            { label: "Alle Notizbücher", icon: "notebook", current: true },
          ],
        },
      ],
    });
  expect(headings(page({ sidebar: nav, head: deeds }))).toEqual(["k2-head-title: Alle Notizbücher"]);
  // the title wins over the Nav
  expect(headings(page({ title: "Rezepte", sidebar: nav, head: deeds }))).toEqual(["k2-head-title: Rezepte"]);
  const tabs = () =>
    createComponent(Bar, {
      get start() {
        return createComponent(Tabs, { label: "Ansichten", items: [{ label: "Alle", current: true, href: "?" }] });
      },
    });
  expect(headings(page({ title: "Aufträge", head: tabs }))).toEqual(["k2-hidden-text: Aufträge"]);
  // a title alone gives the Workspace its head
  const alone = page({ title: "Neue Quelle" });
  expect(alone).toContain('data-slot="head"');
  expect(headings(alone)).toEqual(["k2-head-title: Neue Quelle"]);
  // no name anywhere: no heading (describeV2 names it a finding); no head, no title: no head at all
  expect(headings(page({ head: deeds }))).toEqual([]);
  expect(page({})).not.toContain('data-slot="head"');
});
