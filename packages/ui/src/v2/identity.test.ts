import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../test/ssr-test-plugin";

// What the server sends for things with a face: the whole first view comes from the server, pictures included as
// plain `img` over the symbol, so the page shows the same before and after it comes alive.
const root = mkdtempSync(resolve(tmpdir(), "k2-v2-identity-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { Avatar, Mark, Spark } = await import("./marks");
const { Tiles } = await import("./layout");
const { Digest } = await import("./components");
const { Row } = await import("./content");

const html = <P extends object>(component: (props: P) => JSX.Element, props: P) =>
  renderToString(() => createComponent(component, props));

test("a mark is decoration beside its name, names itself with a label, and sends its picture over its symbol", () => {
  const plain = html(Mark, { icon: "table", color: "#008f4c" });
  expect(plain).toContain('aria-hidden="true"');
  expect(plain).toContain("--k2-c:#008f4c");
  expect(plain).toContain("ti-table");
  expect(plain).not.toContain("<img");

  const picture = html(Mark, { icon: "photo", image: "/thumbs/eiche.jpg", kind: "JPG", label: "Foto" });
  // the mark itself carries the name (its symbol under the picture stays decoration)
  expect(picture).toMatch(/^<span class="k2-mk"[^>]*aria-label="Foto"/);
  expect(picture.slice(0, picture.indexOf(">"))).not.toContain("aria-hidden");
  // the symbol stays under the picture, so a picture that fails leaves it; the picture adds no name
  expect(picture).toContain("ti-photo");
  expect(picture).toMatch(/<img src="\/thumbs\/eiche.jpg" alt(="")? /);
  expect(picture).toContain('data-image=""');
  expect(picture).toMatch(/class="k2-mk-kind" data-k2-glyph(="")?>JPG</);
});

test("a stack shows three people and '+n', named once with every name", () => {
  const people = ["Felix Thal", "Jonas Kern", "Mira Solberg", "Tom Oswald", "Sami Yilmaz"].map((name) => ({ name }));
  const stack = html(Avatar.Stack, { people });
  expect(stack).toContain('aria-label="Felix Thal, Jonas Kern, Mira Solberg, Tom Oswald, Sami Yilmaz"');
  expect(stack.match(/class="k2-av"/g)?.length).toBe(3);
  expect(stack).toContain('<span class="k2-avs-rest" aria-hidden="true">+2</span>');
  expect(html(Avatar.Stack, { people, max: 5 })).not.toContain("k2-avs-rest");
  expect(html(Avatar.Stack, { people, label: "Werkstatt-Team" })).toContain('aria-label="Werkstatt-Team"');
});

test("a spark scales its bars to the highest value and keeps a sliver for a zero", () => {
  const spark = html(Spark, { values: [0, 5, 10], label: "Änderungen" });
  expect(spark).toContain('role="img"');
  expect(spark).toContain('aria-label="Änderungen"');
  expect(spark.match(/--k2-v:(\d+)%/g)).toEqual(["--k2-v:8%", "--k2-v:50%", "--k2-v:100%"]);
  // nothing at all: every bar a sliver, never a division by zero
  expect(html(Spark, { values: [0, 0], label: "Nichts" }).match(/--k2-v:(\d+)%/g)).toEqual(["--k2-v:8%", "--k2-v:8%"]);
});

test("a card sends its mark, figures, people, history and the card that makes a new thing", () => {
  const cards = html(Tiles, {
    variant: "card",
    label: "Bases",
    items: [
      {
        icon: "tool",
        color: "#c2410c",
        title: "Werkstatt",
        meta: "Aufträge und Termine",
        href: "/bases/werkstatt",
        stats: [
          { icon: "table", label: "6 Tabellen" },
          { label: "8 knapp", status: "warn" },
        ],
        people: [{ name: "Felix Thal" }],
        foot: "Felix · vor 2 Min",
        trend: { values: [1, 2, 3], label: "7 Tage" },
      },
    ],
    create: { title: "Neue Base", href: "/bases/neu", choices: [{ label: "CRM", href: "/bases/neu?vorlage=crm" }] },
  });
  expect(cards).toContain('data-variant="card"');
  expect(cards).toContain('href="/bases/werkstatt"');
  expect(cards).toContain('data-status="warn"');
  expect(cards).toContain("Felix · vor 2 Min");
  expect(cards).toContain('aria-label="7 Tage"');
  expect(cards).toContain("data-create");
  expect(cards).toContain('href="/bases/neu?vorlage=crm"');
  // without the variant, the plain tiles stay as they were: no figures, no people, no card that makes a new thing
  const plain = html(Tiles, { items: [{ icon: "file", title: "Plan.pdf", stats: [{ label: "x" }] }], create: { title: "Neu" } });
  expect(plain).not.toContain("k2-tile-stats");
  expect(plain).not.toContain("data-create");
});

test("a row leads with the thing's mark; a person or a box in a selection takes its place", () => {
  expect(html(Row, { lines: ["Aufträge", "128 Einträge"], mark: { icon: "table", color: "#008f4c" } })).toContain("data-mark");
  const person = html(Row, { lines: ["Jana"], mark: { icon: "table" }, avatar: { name: "Jana Berger" } });
  expect(person).not.toContain("k2-mk");
  expect(person).not.toContain("data-mark");
});

test("an activity sends the person, the sentence as the link of the thing, and where and when", () => {
  const activity = html(Digest, {
    label: "Aktivität",
    activity: [
      { person: { name: "Felix Thal" }, text: "Felix Thal hat Aufträge geändert", place: "Werkstatt", time: "09:42", href: "/t/auftraege" },
      { person: { name: "Webformular", initials: "W" }, text: "Neuer Eintrag", time: "09:38" },
    ],
  });
  expect(activity).toContain('aria-label="Felix Thal"');
  expect(activity).toContain('href="/t/auftraege"');
  expect(activity).toContain("Werkstatt · 09:42");
  expect(activity.match(/data-activity/g)?.length).toBe(2);
});
