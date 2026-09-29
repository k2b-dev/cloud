import { describe, expect, test } from "bun:test";
import { LocaleProvider } from "@k2b/ui";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import type { PublicOpening, PublicSection, PublicStatus } from "../contracts";
import "./ssr-test-plugin";

const { PublicSectionView } = await import("./_components/public-section-view.tsx");
const { default: PublicVenuePage } = await import("./public/[slug]/PublicVenuePage.island.tsx");

const timestamp = "2026-09-01T00:00:00.000Z";

const section = (kind: PublicSection["kind"], title: string, content: Record<string, unknown>): PublicSection => ({
  id: `${kind.slice(0, 4).padEnd(4, "x")}01`,
  venueId: "Cafe01",
  kind,
  title,
  content,
  enabled: true,
  position: 0,
  createdAt: timestamp,
  updatedAt: timestamp,
});

const notice = section("notice", "Closed for the team meeting", { text: "We open again at 14:00." });
const markdown = section("markdown", "About us", { markdown: "Fresh **coffee** every day." });
const menu = section("menu", "Autumn menu", {
  items: [
    { name: "Pumpkin soup", price: "4.50 EUR", description: "With roasted seeds", info: "Contains celery" },
    { name: "Summer salad", price: "3.90 EUR", availableUntil: "2000-01-31" },
    { name: "Winter stew", price: "5.20 EUR", availableFrom: "2999-12-01" },
  ],
});
const soldOut = section("menu", "Summer menu", { items: [{ name: "Summer salad", availableUntil: "2000-01-31" }] });
const links = section("links", "Useful links", {
  links: [
    { label: "Student union", href: "https://union.example.org/cafe" },
    { label: "Write to us", href: "mailto:cafe@example.org" },
    { label: "Feedback form", href: "/app/grids/forms/Form01" },
  ],
});
/** Saved before link addresses were checked: visitors can follow none of the last two. */
const legacyLinks = section("links", "Useful links", {
  links: [
    { label: "Student union", href: "https://union.example.org/cafe" },
    { label: "Sneaky", href: "javascript:alert(1)" },
    { label: "Our site", href: "www.cafe.example.org" },
  ],
});

const withLocale = (locale: string, children: () => JSX.Element) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return children();
      },
    }),
  );

/**
 * The section inside a theme scope, as the `<html>` class sets it on a Cloud page. The markup itself must not
 * depend on the theme: tokens resolve the colors.
 */
const renderSection = (value: PublicSection, { theme = "light", preview = false }: { theme?: "light" | "dark"; preview?: boolean } = {}) =>
  `<div class="${theme}">${withLocale("en", () => createComponent(PublicSectionView, { section: value, timeZone: "Europe/Berlin", preview }))}</div>`;

/** Fixed palette classes the old public page used instead of theme tokens. */
const FIXED_COLORS = /\b(?:bg-white|text-zinc-\d{3}|bg-zinc-\d{3}|ring-black|shadow-(?:sm|md|lg|xl))\b/;

const venue: PublicStatus["venue"] = {
  id: "Cafe01",
  slug: "corner-cafe",
  name: "Corner Café at the Old Library of the Faculty of Natural Sciences",
  icon: "ti ti-coffee",
  description: "Coffee and cake between lectures.",
  timezone: "Europe/Berlin",
  openMode: "combined",
  signupMode: "both",
  publicEnabled: true,
  feedbackEnabled: true,
  accentColor: "#2563eb",
  logoBase64: null,
  bannerBase64: null,
  permission: "none",
  createdAt: timestamp,
  updatedAt: timestamp,
};

const opening = (day: number): PublicOpening => ({
  kind: "shift",
  title: "Additionally open",
  startsAt: `2099-10-${String(day).padStart(2, "0")}T15:00:00.000Z`,
  endsAt: `2099-10-${String(day).padStart(2, "0")}T19:00:00.000Z`,
});

const everyDay = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  id: `Rule0${weekday}`,
  venueId: "Cafe01",
  weekday,
  startTime: "11:00",
  endTime: "18:00",
  note: null,
  position: 0,
  createdAt: timestamp,
  updatedAt: timestamp,
}));

const status = (overrides: Partial<PublicStatus> = {}): PublicStatus => ({
  venue,
  open: true,
  spontaneousOpen: false,
  statusLabel: "Open now",
  todayLabel: "11:00–18:00",
  nextOpeningLabel: "Tue, 30 Sep, 11:00",
  activeWindowLabel: "11:00–18:00",
  upcomingOpenings: [],
  upcomingExceptions: [
    { date: "2099-10-03", kind: "closed", startTime: null, endTime: null, note: "Public holiday" },
    { date: "2099-10-17", kind: "open", startTime: "18:00", endTime: "23:00", note: "Long night" },
  ],
  openingRules: everyDay,
  sections: [notice, menu],
  ...overrides,
});

const renderPage = (value: PublicStatus, displayHeight: "scroll" | "full" = "scroll", locale = "en") =>
  withLocale(locale, () =>
    createComponent(PublicVenuePage, {
      venueId: "Cafe01",
      initialStatus: value,
      displayHeight,
      feedbackUrl: "https://cloud.example.org/app/venue/public/Cafe01/feedback",
      refresh: false,
    }),
  );

const withoutHydrationKeys = (html: string) => html.replace(/ data-hk="[^"]*"/g, "");

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

describe("One public section renderer", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`renders every kind on theme tokens only (${theme})`, () => {
      for (const value of [notice, markdown, menu, links]) {
        const html = renderSection(value, { theme });
        expect({ kind: value.kind, fixed: html.match(FIXED_COLORS)?.[0] ?? null }).toEqual({ kind: value.kind, fixed: null });
        expect(html).toContain(`data-section-kind="${value.kind}"`);
        expect(html).toContain(`>${value.title}</h2>`);
      }
    });
  }

  test("highlights a notice as a notice card with its text", () => {
    const html = renderSection(notice);
    expect(html).toContain("k2b-notice-card");
    expect(html).toContain('data-tone="warning"');
    expect(text(html)).toContain("Closed for the team meeting We open again at 14:00.");
  });

  test("previews only menu items inside their availability dates", () => {
    const html = text(renderSection(menu, { preview: true }));
    expect(html).toContain("Pumpkin soup");
    expect(html).toContain("4.50 EUR");
    expect(html).toContain("(Contains celery)");
    expect(html).not.toContain("Summer salad");
    expect(html).not.toContain("Winter stew");
    expect(text(renderSection(soldOut, { preview: true }))).toContain(
      "No item is available today, so the public page leaves this menu out.",
    );
  });

  test("shows the menu items the server chose for the public page and never the preview's note", () => {
    // The server filters by its date; the visitor's clock, maybe past midnight already, does not filter again.
    const html = text(renderSection(soldOut));
    expect(html).toContain("Summer salad");
    const empty = renderSection(section("menu", "Empty menu", { items: [] }));
    expect(empty).not.toContain('data-section-kind="menu"');
    expect(text(empty)).not.toContain("the public page leaves this menu out");
  });

  test("turns web, mail, and Cloud addresses into link cards and never a script link", () => {
    const html = renderSection(links);
    expect(html.match(/<a [^>]*class="k2b-paper k2b-link-card\b/g)?.length).toBe(3);
    expect(html).toContain('href="https://union.example.org/cafe"');
    expect(html).toContain('href="mailto:cafe@example.org"');
    expect(html).toContain('href="/app/grids/forms/Form01"');
    expect(text(html)).toContain("union.example.org");
    expect(text(html)).toContain("/app/grids/forms/Form01");
    expect(renderSection(links, { preview: true })).not.toContain("k2b-inline-guidance");
  });

  test("leaves out a stored link visitors cannot follow, and the preview says so", () => {
    const visitor = renderSection(legacyLinks);
    expect(visitor.match(/<a [^>]*class="k2b-paper k2b-link-card\b/g)?.length).toBe(1);
    expect(visitor).not.toContain("javascript:");
    expect(visitor).not.toContain("Sneaky");
    expect(visitor).not.toContain("www.cafe.example.org");
    expect(text(visitor)).not.toContain("Visitors don't see");
    const preview = text(renderSection(legacyLinks, { preview: true }));
    expect(preview).toContain("Visitors don't see 2 links because their addresses do not start with https://, mailto:, tel:, or /.");
  });

  test("renders Markdown", () => {
    expect(renderSection(markdown)).toContain("<strong>coffee</strong>");
  });

  test("is exactly what the public page shows for the section", () => {
    const notices = (html: string) => (html.match(/<article[^>]*k2b-notice-card[\s\S]*?<\/article>/g) ?? []).map(withoutHydrationKeys);
    const [view] = notices(renderSection(notice));
    expect(view).toBeDefined();
    expect(notices(renderPage(status({ sections: [notice] })))).toEqual([view!]);
  });
});

describe("Venue public page", () => {
  test("reads status, hours, changed hours, content, and feedback in that order", () => {
    const html = renderPage(status());
    const order = ["status", "facts", "sections", "feedback"].map((block) => html.indexOf(`data-public-block="${block}"`));
    expect(order.every((index) => index >= 0)).toBeTrue();
    expect(order).toEqual(order.toSorted((a, b) => a - b));

    const facts = text(html.slice(order[1], order[2]));
    expect(facts.indexOf("Regular hours")).toBeLessThan(facts.indexOf("Changed hours"));
    expect(facts).toContain("Sat, Oct 3 Closed · Public holiday");
    expect(facts).toContain("Sat, Oct 17 Special opening 18:00–23:00 · Long night");
    // This week's hours start open and fold away natively.
    expect(html).toMatch(/<details[^>]*class="k2b-disclosure public-hours[^"]*"[^>]*open/);
    expect(facts).toContain("Monday 11:00–18:00");
  });

  test("formats every time range with an en dash and every date without a zero-padded day", () => {
    const html = text(
      renderPage(
        status({
          venue: { ...venue, openMode: "combined" },
          upcomingOpenings: [opening(3)],
          // Monday stays closed; Tuesday has two windows.
          openingRules: [
            ...everyDay.filter((rule) => rule.weekday !== 1),
            { ...everyDay[2]!, id: "Rule2b", startTime: "19:00", endTime: "22:00", note: "Bar" },
          ],
        }),
      ),
    );
    expect(html).toContain("Monday Closed");
    expect(html).toContain("Tuesday 11:00–18:00 & 19:00–22:00 (Bar)");
    expect(html).toContain("Sat, Oct 3 17:00–21:00");
    expect(html).not.toMatch(/\d{2}:\d{2}-\d{2}:\d{2}/);

    const german = text(renderPage(status({ venue: { ...venue, openMode: "combined" }, upcomingOpenings: [opening(3)] }), "scroll", "de"));
    expect(german).toContain("Sa., 3. Okt. 17:00–21:00");
    expect(german).not.toContain("03. Okt.");
  });

  test("lists all seven weekdays from Monday once regular hours exist, closed days included", () => {
    const html = text(renderPage(status({ openingRules: everyDay.filter((rule) => rule.weekday === 3) })));
    const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((day) => html.indexOf(day));
    expect(days.every((index) => index >= 0)).toBeTrue();
    expect(days).toEqual(days.toSorted((a, b) => a - b));
    expect(html.split("Closed").length - 1).toBeGreaterThanOrEqual(6);
    expect(html).toContain("Wednesday 11:00–18:00");
  });

  test("names the current window once and has no separate Today card", () => {
    const html = text(renderPage(status({ openingRules: [], activeWindowLabel: "11:00–18:00" })));
    expect(html.split("11:00–18:00").length - 1).toBe(1);
    expect(html).not.toContain("Today");
  });

  test("says in one sentence that nothing is planned when a venue has no hours", () => {
    const html = text(
      renderPage(
        status({
          open: false,
          activeWindowLabel: null,
          nextOpeningLabel: null,
          todayLabel: "No regular hours today",
          openingRules: [],
          upcomingExceptions: [],
        }),
      ),
    );
    expect(html.split("No opening is planned in the next two weeks.").length - 1).toBe(1);
    expect(html).not.toContain("No regular hours today");
    expect(html).not.toContain("Changed hours");
  });

  test("wraps a long venue name instead of cutting it", () => {
    const html = renderPage(status());
    const heading = html.match(/<h1[^>]*>/)?.[0] ?? "";
    expect(heading).toContain("line-clamp-2");
    expect(heading).not.toContain("truncate");
  });

  test("keeps in-flow surfaces quiet and on theme tokens", () => {
    const html = renderPage(status({ sections: [notice, markdown, menu, links] }));
    expect(html).not.toMatch(/\bshadow-(?:lg|xl)\b/);
    expect(html.match(FIXED_COLORS)?.[0] ?? null).toBeNull();
  });

  test("speaks German on a German request", () => {
    const html = text(renderPage(status(), "scroll", "de"));
    expect(html).toContain("Abweichende Zeiten");
    expect(html).toContain("Sa., 3. Okt. Geschlossen · Public holiday");
  });
});

describe("Venue monitor", () => {
  test("stacks into one column in portrait and uses two columns only in landscape", () => {
    const html = renderPage(status(), "full");
    const layout = html.match(/<div[^>]*data-display-layout[^>]*>/)?.[0] ?? "";
    expect(layout).toContain("flex-col");
    expect(layout).toContain("landscape:grid-cols-2");
    expect(layout).not.toMatch(/(?:^|\s)(?:lg|md|sm):grid-cols/);
  });

  test("says how many openings and exceptions it leaves out", () => {
    const html = renderPage(
      status({
        upcomingOpenings: [1, 2, 3, 4, 5, 6, 7, 8].map(opening),
        upcomingExceptions: [3, 10, 17, 24, 31].map((day) => ({
          date: `2099-10-${String(day).padStart(2, "0")}`,
          kind: "closed" as const,
          startTime: null,
          endTime: null,
          note: null,
        })),
      }),
      "full",
    );
    const block = (name: string) => {
      const start = html.indexOf(`data-public-block="${name}"`);
      const end = html.indexOf("data-public-block=", start + 1);
      return html.slice(start, end < 0 ? undefined : end);
    };
    expect(block("openings")).toContain('data-fit-more="3"');
    expect(text(block("openings"))).toContain("+3 more");
    expect(block("openings").match(/data-fit-row class="invisible" aria-hidden="true"/g)?.length).toBe(3);
    expect(block("exceptions")).toContain('data-fit-more="2"');
    // All seven weekdays fit before the browser measures; nothing is counted as left out.
    expect(block("hours")).not.toContain("data-fit-more=");
    expect(text(block("hours"))).toContain("Sunday");
  });

  test("keeps one column on a wide screen when the second column would stay empty", () => {
    const layout = (value: PublicStatus) => renderPage(value, "full").match(/<div[^>]*data-display-layout[^>]*>/)?.[0] ?? "";
    const regular = { ...venue, openMode: "regular" as const, feedbackEnabled: false };
    const alone = renderPage(status({ venue: regular, upcomingExceptions: [] }), "full");
    expect(layout(status({ venue: regular, upcomingExceptions: [] }))).not.toContain("landscape:grid-cols-2");
    expect(alone).toContain('data-venue-status="open"');
    expect(alone).toContain('data-public-block="hours"');
    // Any of exceptions, staffed openings, or the feedback code fills the second column.
    expect(layout(status({ venue: regular }))).toContain("landscape:grid-cols-2");
    expect(layout(status({ venue: { ...regular, openMode: "combined" }, upcomingExceptions: [] }))).toContain("landscape:grid-cols-2");
    expect(layout(status({ venue: { ...regular, feedbackEnabled: true }, upcomingExceptions: [] }))).toContain("landscape:grid-cols-2");
  });

  test("keeps the feedback QR code on a light tile and the surfaces on tokens", () => {
    const html = renderPage(status(), "full");
    expect(html).toContain("rounded-lg bg-white p-2");
    // Whether the code fits is measured in the browser, not guessed from the screen's shape.
    const qr = html.match(/<section[^>]*data-public-block="feedback-qr"[^>]*>/)?.[0] ?? "";
    expect(qr).not.toBe("");
    expect(qr).not.toContain("hidden");
    expect(qr).not.toContain("portrait");
    expect(html).not.toMatch(/\bshadow-(?:lg|xl)\b/);
  });
});
