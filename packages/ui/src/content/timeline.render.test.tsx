import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { timelineFrom, timelineItems, timelineNow, timelineTo, timelineZone } from "../../test/timeline-data";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-timeline-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { LocaleProvider, Timeline } = await import("../index");
type Props = import("./Timeline").TimelineProps;

const render = (locale: string, extra: Partial<Props> = {}) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(Timeline, {
          items: timelineItems,
          from: timelineFrom,
          to: timelineTo,
          now: timelineNow,
          timeZone: timelineZone,
          ...extra,
        });
      },
    }),
  );
const decode = (html: string) => html.replaceAll("&#39;", "'").replaceAll("&amp;", "&");
const headings = (html: string) => [...html.matchAll(/<h3[^>]*>(.*?)<\/h3>/g)].map((match) => match[1]!.replace(/<[^>]+>/g, " ").trim());

describe("Timeline", () => {
  test("renders a labelled region with a heading and an ordered list per day on the server", () => {
    const html = decode(render("en"));
    expect(html).toMatch(/<section[^>]*class="k2b-timeline "[^>]*aria-label="Timeline"[^>]*aria-describedby="[^"]+-hint"/);
    expect(html).toContain("Arrow keys move between items, Page Up and Page Down between days");
    expect(headings(html)).toEqual([
      "Wed, Oct 7",
      "Today  Thu, Oct 8",
      "Fri, Oct 9",
      "Sat, Oct 10 – Sun, Oct 11",
      "Mon, Oct 12",
      "Tue, Oct 13",
    ]);
    const lists = [...html.matchAll(/<ol class="k2b-timeline__list" aria-labelledby="([^"]+)"/g)].map((match) => match[1]);
    expect(lists).toHaveLength(5);
    for (const id of lists) expect(html).toContain(`id="${id}"`);
  });

  test("names every item with its time, detail, day, and checkbox state, and makes exactly one a tab stop", () => {
    const html = decode(render("en"));
    expect(html).toContain('aria-label="Release planning 4.2, 16:00 to 17:30, Room Schlei, Thursday, October 8"');
    expect(html).toContain('aria-label="Release planning slides, 15:30, Task, Thursday, October 8, open"');
    expect(html).toContain('aria-label="October onboarding workshop, All day, Thursday, October 8 – Friday, October 9"');
    expect(html).toContain('aria-label="Server maintenance, 01:00 to 02:00, Friday, October 9"');
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    // The next entry at or after now holds the tab stop.
    expect(html).toMatch(/data-entry-id="t1"[^>]*tabindex="0"/);
  });

  test("speaks German with the inherited locale", () => {
    const html = decode(render("de"));
    expect(html).toContain('aria-label="Zeitleiste"');
    expect(headings(html).slice(0, 4)).toEqual(["Mi., 7. Okt.", "Heute  Do., 8. Okt.", "Fr., 9. Okt.", "Sa., 10. Okt. – So., 11. Okt."]);
    expect(html).toContain('aria-label="Release planning 4.2, 16:00 bis 17:30, Room Schlei, Donnerstag, 8. Oktober"');
    expect(html).toContain('aria-label="Release planning slides, 15:30, Task, Donnerstag, 8. Oktober, offen"');
    expect(html).toContain("Nacht · 22:00–06:00");
    expect(html).toContain("2,5 Std. frei");
    expect(html).toContain("Pfeiltasten wechseln den Eintrag");
  });

  test("keeps folds, hours, free time, and the now line out of the accessibility tree", () => {
    const html = decode(render("en"));
    expect(html).toMatch(/<div class="k2b-timeline__decor" aria-hidden="true">/);
    expect(html).toContain("Night · 22:00–06:00");
    expect(html).toContain("2.5 hr free");
    expect(html).toMatch(/class="k2b-timeline__now" aria-hidden="true"[^>]*style="--k2b-timeline-at:calc\([^"]+\)"/);
    expect(html).toContain('<span class="k2b-timeline__now-time">14:20</span>');
    for (const decoration of html.matchAll(/class="k2b-timeline__(?:fold|hour|gap)"/g)) expect(decoration).toBeTruthy();
    expect(html).not.toMatch(/class="k2b-timeline__(?:fold|hour|gap)"[^>]*tabindex/);
  });

  test("places entries with CSS lengths built from the axis units, never with measured pixels", () => {
    const html = decode(render("en"));
    const slot = html.match(/<li class="k2b-timeline__slot" data-kind="band"[^>]*style="([^"]+)"[^>]*><button[^>]*data-entry-id="e6"/);
    expect(slot?.[1]).toContain("--k2b-timeline-at:calc(");
    expect(slot?.[1]).toContain("var(--k2b-timeline-hour)");
    expect(slot?.[1]).toContain("--k2b-timeline-size:calc(1.5 * var(--k2b-timeline-hour))");
    expect(slot?.[1]).not.toMatch(/\d+px/);
    expect(html).toMatch(/class="k2b-timeline__track" style="--k2b-timeline-length:calc\(/);
  });

  test("renders links for items with href, hex colors as an accent, and the region busy on request", () => {
    const html = decode(
      render("en", {
        items: [
          {
            id: "x",
            label: "Linked",
            start: "2026-10-08T09:00:00+02:00",
            end: "2026-10-08T10:00:00+02:00",
            href: "/item/x",
            color: "#0284c7",
          },
        ],
        busy: true,
        label: "Product team timeline",
      }),
    );
    expect(html).toContain('aria-label="Product team timeline"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/<a [^>]*href="\/item\/x" class="k2b-timeline__item ?" data-entry-id="x"/);
    expect(html).toContain("--k2b-timeline-accent:#0284c7");
  });

  test("renders only the days near the start of a long range on the server, plus the tab stop's day", () => {
    const items = Array.from({ length: 120 }, (_, day) => ({
      id: `m${day}`,
      label: `Meeting ${day}`,
      start: new Date(Date.UTC(2026, 9, 7 + day, 8)).toISOString(),
      end: new Date(Date.UTC(2026, 9, 7 + day, 9)).toISOString(),
    }));
    const html = render("en", { items, to: "2027-02-01T00:00:00+01:00", now: "2026-12-24T08:00:00+01:00" });
    const shown = headings(html);
    // About 3,200 px of the strip from its start, and Christmas Eve, which holds the tab stop.
    expect(shown).toEqual(["Wed, Oct 7", "Thu, Oct 8", "Fri, Oct 9", "Sat, Oct 10", "Sun, Oct 11", "Today  Thu, Dec 24"]);
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html).toMatch(/data-entry-id="m78"[^>]*tabindex="0"/);
  });

  test("makes the scroll area the tab stop when there is nothing to focus", () => {
    const html = render("en", { items: [] });
    expect(html).toMatch(/class="k2b-timeline__viewport" tabindex="0"/);
    expect(html).toContain("Nothing planned");
  });
});
