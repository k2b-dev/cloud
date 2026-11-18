import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-activity-list-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { ActivityCard, ActivityList } = await import("./ActivityList");
const { LocaleProvider } = await import("../intl/locale");
type Entry = import("./ActivityList").ActivityEntry;

// Thursday, 12 Nov 2026, 16:31 in Berlin: the "now" of the approved mockup.
const NOW = "2026-11-12T15:31:00Z";
const ZONE = "Europe/Berlin";

const draft = (minute: string): Entry => ({
  at: `2026-10-27T10:${minute}:00+01:00`,
  icon: "ti ti-pencil",
  text: "Entwurf geändert",
  bundle: { key: "draft", text: (count) => `Entwurf ${count}-mal geändert` },
  actor: "Elif Kaya",
  kind: "change",
});
const entries = (): Entry[] => [
  {
    at: "2026-11-12T08:31:00+01:00",
    icon: "ti ti-mail-x",
    tone: "danger",
    text: "Einladung unzustellbar",
    detail: "team@stadtpark.example · Postfach voll",
    action: { icon: "ti ti-send", label: "Einladung erneut senden", data: "resend" },
    kind: "mail",
  },
  {
    at: "2026-11-10T14:05:00+01:00",
    icon: "ti ti-circle-check",
    tone: "success",
    text: "Freigegeben",
    detail: createComponent(ActivityList.Change, { term: "Stand", before: "In Prüfung", now: "Freigegeben" }),
    actor: "Jonas Weber",
    kind: "change",
  },
  { at: "2026-10-28T08:14:00+01:00", icon: "ti ti-eye", text: "Über den Link geöffnet", actor: "Gast" },
  draft("35"),
  draft("30"),
  draft("24"),
  draft("20"),
  { at: "2026-10-27T10:05:00+01:00", icon: "ti ti-plus", text: "Aus Vorlage erstellt", actor: "Tom Reiter", kind: "change" },
];

const german = (children: () => JSX.Element) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return children();
      },
    }),
  ).replace(/ data-hk="[^"]*"/g, "");
const list = (props: Partial<import("./ActivityList").ActivityListProps> = {}) =>
  german(() => createComponent(ActivityList, { entries: entries(), now: NOW, timeZone: ZONE, ...props }));
// The rendered text as a parser reads it: text nodes only, without tags or hydration comments.
const text = (html: string) => {
  let plain = "";
  new HTMLRewriter()
    .onDocument({
      text(chunk) {
        plain += chunk.text;
      },
    })
    .transform(html);
  return plain.replace(/\s+/g, " ");
};

test("renders the timeline with dashed dividers, avatars, time labels, and a bundle with its count", () => {
  const html = list();
  expect(html).toContain('class="k2b-activity"');
  expect(html).toContain('data-density="compact"');
  expect(html).toContain('aria-label="Verlauf"');
  // Dividers: today, a day of the last week by name, then once "more than a week ago".
  expect(html.match(/class="k2b-activity__day"/g)).toHaveLength(3);
  const plain = text(html);
  expect(plain).toContain("Heute");
  expect(plain).toContain("Di., 10. Nov.");
  expect(plain).toContain("Vor über einer Woche");
  // Meta: time · distance · person, "automatisch" without a person; older entries with day and time.
  expect(plain).toContain("automatisch · Einladung unzustellbar");
  expect(html).toContain("vor 8 Std.");
  expect(html).not.toContain(" title=");
  expect(html).toContain("k2b-activity__avatar");
  expect(plain).toContain("Jonas Weber · Freigegeben");
  expect(plain).toContain("14:05");
  expect(plain).toContain("Elif Kaya · Entwurf 4-mal geändert");
  expect(plain).toContain("27. Okt., 10:35");
  // Four drafts in a row on one day by one person are one row.
  expect(plain).toContain("Entwurf 4-mal geändert");
  expect(html).toContain('data-count="4"');
  expect(html.match(/class="k2b-activity__entry ?"/g)).toHaveLength(5);
  // A failure keeps its status mark; a redundant success icon stays out of the sentence.
  expect(html).not.toContain('class="ti ti-circle-check"');
  expect(html).toContain('data-tone="danger"');
  expect(html).toContain('<span class="k2b-activity__before">In Prüfung</span>');
  // The row is a focus target after a reload, never in the tab order.
  expect(html).toContain('tabindex="-1"');
});

test("the first row starts the rail and the last ends it; a limit or more pages let it fade out", () => {
  const full = list();
  expect(full).toContain("data-first");
  expect(full).toContain('data-end="last"');
  expect(full).not.toContain('data-end="more"');
  const limited = list({ limit: 3 });
  expect(limited.match(/class="k2b-activity__entry ?"/g)).toHaveLength(3);
  expect(limited).toContain('data-end="more"');
  expect(list({ more: true })).toContain('data-end="more"');
});

test("an action is a link with an href and a button otherwise; wide puts the meta after the text column", () => {
  const html = list({ density: "wide" });
  expect(html).toContain('data-density="wide"');
  expect(html).toMatch(/<button type="button" class="k2b-activity__action"[^>]*data-activity-action="resend"/);
  const linked = german(() =>
    createComponent(ActivityList, {
      entries: [{ at: NOW, icon: "ti ti-file", text: "Datei", action: { icon: "ti ti-download", label: "Laden", href: "/f" } }],
      now: NOW,
      timeZone: ZONE,
    }),
  );
  expect(linked).toMatch(/<a class="k2b-activity__action" href="\/f"/);
  // In the wide density the meta line follows the text column inside the row.
  expect(html.indexOf("k2b-activity__meta")).toBeGreaterThan(html.indexOf("team@stadtpark.example"));
});

test("a clickable entry renders its sentence as a button that says whether details are open", () => {
  const html = german(() =>
    createComponent(ActivityList, {
      entries: [{ at: NOW, icon: "ti ti-mail", text: "Per E-Mail gesendet", details: () => "An team@stadtpark.example" }],
      now: NOW,
      timeZone: ZONE,
    }),
  );
  expect(html).toContain("data-clickable");
  expect(html).toMatch(/<button type="button" class="k2b-activity__text-button" aria-expanded="false"/);
  expect(html).not.toContain("An team@stadtpark.example");
});

test("a row with href renders its sentence as a link, never inside a button; details win over href", () => {
  const html = (entry: Partial<Entry>) =>
    german(() =>
      createComponent(ActivityList, {
        entries: [{ at: NOW, icon: "ti ti-check", text: "Aufgabe erledigt", ...entry }],
        now: NOW,
        timeZone: ZONE,
      }),
    );
  const linked = html({ href: "/app/spaces/s1?item=i1" });
  expect(linked).toContain("data-clickable");
  expect(linked).toContain('<a class="k2b-activity__text-link" href="/app/spaces/s1?item=i1">');
  expect(text(linked)).toContain("Aufgabe erledigt");
  expect(linked).not.toContain("k2b-activity__text-button");
  const folding = html({ href: "/app/spaces/s1", details: () => "Betreff" });
  expect(folding).toContain('class="k2b-activity__text-button" aria-expanded="false"');
  expect(folding).not.toContain("k2b-activity__text-link");
});

test("the card's title is a second-level heading unless the page asks for the third", () => {
  const card = (level?: 2 | 3) => german(() => createComponent(ActivityCard, { entries: entries(), now: NOW, timeZone: ZONE, level }));
  expect(card()).toContain("<h2");
  expect(card()).not.toContain("<h3");
  expect(card(3)).toContain("<h3");
  expect(card(3)).not.toContain("<h2");
});

test("loading, empty, and error states", () => {
  const loading = german(() => createComponent(ActivityList.Loading, {}));
  expect(loading).toContain('role="status"');
  expect(loading.match(/k2b-activity__placeholder-line/g)).toHaveLength(3);
  expect(text(german(() => createComponent(ActivityList.Empty, {})))).toContain("Noch nichts passiert.");
  const error = german(() => createComponent(ActivityList.Error, { onReload: () => {} }));
  expect(error).toContain('role="alert"');
  expect(text(error)).toContain("Der Verlauf ließ sich nicht laden. Neu laden");
});

test("the card shows its limit of rows and 'All N' counting rows; an error with entries stays above the list", () => {
  const card = (props: Partial<import("./ActivityList").ActivityCardProps>) =>
    german(() => createComponent(ActivityCard, { entries: entries(), now: NOW, timeZone: ZONE, ...props }));
  const four = card({ limit: 4 });
  // Five rows: 8 entries, the four drafts bundled into one.
  expect(text(four)).toContain("Alle 5");
  expect(four.match(/class="k2b-activity__entry ?"/g)).toHaveLength(4);
  expect(card({})).not.toContain("data-activity-all");
  const failed = card({ error: true, onReload: () => {} });
  expect(failed.indexOf('role="alert"')).toBeLessThan(failed.indexOf('class="k2b-activity"'));
  expect(card({ entries: null })).toContain('role="status"');
  expect(card({ entries: null, error: true })).toContain('role="alert"');
  expect(text(card({ entries: [] }))).toContain("Noch nichts passiert.");
  expect(text(card({ entries: [], lead: "Wartet auf die Freigabe" }))).not.toContain("Noch nichts passiert.");
});

test("the server renders the given now, so the first browser render agrees", () => {
  const a = list();
  const b = list();
  expect(a).toBe(b);
});

test("the public row works in a feed and keeps identity kinds and pictures without native hints", () => {
  const row = (entry: Entry) => german(() => createComponent(ActivityList.Row, { entry, now: NOW, timeZone: ZONE, selected: true }));
  const person = row({
    at: NOW,
    actor: "Mira Lang",
    text: "Kommentar ergänzt",
    href: "/conversation",
    avatar: { name: "Mira Lang", kind: "person", src: "/fixture-mira.svg" },
  });
  expect(person).toContain('src="/fixture-mira.svg"');
  expect(person).toContain('aria-current="true"');
  expect(person).toContain("data-selected");
  expect(person).not.toContain("<li");
  expect(person).not.toContain(" title=");
  const service = row({ at: NOW, actor: "Workflow", text: "Importiert", avatar: { name: "Workflow", kind: "service" } });
  expect(service).toContain('class="ti ti-robot"');
  expect(service).toContain('data-shape="square"');
  expect(service).not.toContain("data-tint=");
  const removed = row({ at: NOW, actor: "Gelöschter Benutzer", text: "Geändert", avatar: { name: "Gelöschter Benutzer", kind: "system" } });
  expect(removed).toContain('class="ti ti-settings"');
  expect(removed).not.toContain("data-tint=");
});
